// scripts/weekly-shorts-update.js
// Generates static JSON for Weekly Shorts page (GitHub Pages friendly)
// - weeks index: data/weekly-shorts/weeks.json
// - per-week file: data/weekly-shorts/weeks/<week>.json   (contains points leaderboard as `entries`)
// - aggregate: data/weekly-shorts/aggregate.json          (wins from points, WRs/top5 from map leaderboards)
// - changelog: data/weekly-shorts/changelog.json          (optional; keeps prior format)
//
// Node 18+ (global fetch). ESM module.

import fs from "node:fs";
import path from "node:path";

/* ----------------------------- config ----------------------------- */
const PUBLIC_DIR = process.env.PUBLIC_DIR || ".";
const BASE_DIR = path.join(process.cwd(), PUBLIC_DIR, "data", "weekly-shorts");
const WEEKS_DIR = path.join(BASE_DIR, "weeks");

const WEEKS_INDEX_PATH = path.join(BASE_DIR, "weeks.json");
const AGG_PATH = path.join(BASE_DIR, "aggregate.json");
const CHANGELOG_PATH = path.join(BASE_DIR, "changelog.json");
const NAME_CACHE_PATH = path.join(BASE_DIR, "name-cache.json");

const DEBUG = String(process.env.DEBUG || "0") === "1";
const dlog = (...a) => DEBUG && console.log("[WS]", ...a);

// Nadeo Live
const LIVE_BASE = "https://live-services.trackmania.nadeo.live";
const CORE_REFRESH_URL =
  "https://prod.trackmania.core.nadeo.online/v2/authentication/token/refresh";

// OAuth (display names)
const OAUTH_CLIENT_ID = process.env.CLIENT_ID;
const OAUTH_CLIENT_SECRET = process.env.CLIENT_SECRET;

// Live refresh token (nadeo_v1 refresh)
const REFRESH_TOKEN = cleanToken(process.env.REFRESH_TOKEN || "");

// Optional: limit start date for weeks index (default: 2024 start)
const WS_START_ISO = String(process.env.WS_START_ISO || "2024-01-01T00:00:00Z").trim();

// Tuning
const WS_MAPS_PER_WEEK = Number(process.env.WS_MAPS_PER_WEEK || 5);
const MAP_TOP_LENGTH = Number(process.env.WS_MAP_TOP_LENGTH || 10);
const POINTS_TOP_LENGTH = Number(process.env.WS_POINTS_TOP_LENGTH || 10);
const SLEEP_MS = Number(process.env.WS_SLEEP_MS || 70);

/* ----------------------------- helpers ----------------------------- */
function isoNow() {
  return new Date().toISOString();
}
function cleanToken(s) {
  if (!s) return "";
  let t = String(s).trim();
  if (t.toLowerCase().startsWith("nadeo_v1 t=")) t = t.slice("nadeo_v1 t=".length).trim();
  if ((t.startsWith('"') && t.endsWith('"')) || (t.startsWith("'") && t.endsWith("'"))) t = t.slice(1, -1);
  return t;
}
function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}
function ensureDir(p) {
  fs.mkdirSync(p, { recursive: true });
}
function readJson(p, fallback) {
  try {
    return JSON.parse(fs.readFileSync(p, "utf8"));
  } catch {
    return fallback;
  }
}
function writeJson(p, obj) {
  ensureDir(path.dirname(p));
  fs.writeFileSync(p, JSON.stringify(obj, null, 2) + "\n", "utf8");
}
function parseStartMs() {
  const ms = Date.parse(WS_START_ISO);
  if (!Number.isFinite(ms)) throw new Error(`Invalid WS_START_ISO: ${WS_START_ISO}`);
  return ms;
}
function isValidTimeMs(ms) {
  return Number.isFinite(ms) && ms > 0 && ms < 24 * 3600 * 1000;
}

async function fetchRetry(url, opts = {}, retries = 5, baseDelay = 400) {
  let lastErr;
  for (let i = 0; i <= retries; i++) {
    try {
      const r = await fetch(url, opts);
      if (r.status === 429 || (r.status >= 500 && r.status <= 599)) {
        const wait = Math.min(baseDelay * Math.pow(2, i), 8000);
        dlog("retry", i, r.status, url, "wait", wait);
        await sleep(wait);
        continue;
      }
      return r;
    } catch (e) {
      lastErr = e;
      const wait = Math.min(baseDelay * Math.pow(2, i), 8000);
      dlog("retry", i, "err", e?.message || e, url, "wait", wait);
      await sleep(wait);
    }
  }
  throw lastErr || new Error(`fetch failed for ${url}`);
}

/* ----------------------------- auth ----------------------------- */
let cachedLive = { token: null, expAt: 0 };

async function getLiveAccessToken() {
  const now = Date.now();
  if (cachedLive.token && now < cachedLive.expAt - 30_000) return cachedLive.token;

  if (!REFRESH_TOKEN) throw new Error("Missing REFRESH_TOKEN env (Nadeo refresh token).");

  const r = await fetchRetry(CORE_REFRESH_URL, {
    method: "POST",
    headers: {
      Authorization: `nadeo_v1 t=${REFRESH_TOKEN}`,
      "Content-Type": "application/json",
      "User-Agent": "trackmaniaevents.com/weekly-shorts (github action)",
    },
    body: "{}",
  });

  if (!r.ok) {
    const body = await r.text().catch(() => "");
    throw new Error(`refresh failed ${r.status} ${body || "(no body)"} [len=${REFRESH_TOKEN.length}]`);
  }

  const j = await r.json();
  const accessToken = j.accessToken || j.access_token;
  const expiresIn = j.expiresIn || j.expires_in || 3600;
  if (!accessToken) throw new Error("no accessToken in refresh response");

  cachedLive = { token: accessToken, expAt: Date.now() + expiresIn * 1000 };
  return cachedLive.token;
}

async function jget(url, access) {
  const r = await fetchRetry(url, {
    headers: {
      Authorization: `nadeo_v1 t=${access}`,
      Accept: "application/json",
      "User-Agent": "trackmaniaevents.com/weekly-shorts (github action)",
    },
  });
  if (!r.ok) throw new Error(`${url} -> ${r.status}`);
  return r.json();
}

/* ----------------------------- OAuth display names ----------------------------- */
let cachedOAuth = { token: null, expAt: 0 };
async function getOAuthToken() {
  const now = Date.now();
  if (cachedOAuth.token && now < cachedOAuth.expAt - 30_000) return cachedOAuth.token;

  if (!OAUTH_CLIENT_ID || !OAUTH_CLIENT_SECRET) {
    throw new Error("Missing CLIENT_ID / CLIENT_SECRET env (Trackmania OAuth).");
  }

  const r = await fetchRetry("https://api.trackmania.com/api/access_token", {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      "User-Agent": "trackmaniaevents.com/weekly-shorts (github action)",
    },
    body: new URLSearchParams({
      grant_type: "client_credentials",
      client_id: OAUTH_CLIENT_ID,
      client_secret: OAUTH_CLIENT_SECRET,
    }).toString(),
  });

  if (!r.ok) throw new Error(`oauth token failed ${r.status} ${await r.text().catch(() => "")}`);
  const j = await r.json();
  const accessToken = j.access_token || j.accessToken;
  const expiresIn = j.expires_in || 3600;
  if (!accessToken) throw new Error("no OAuth access_token");

  cachedOAuth = { token: accessToken, expAt: Date.now() + expiresIn * 1000 };
  return cachedOAuth.token;
}

async function resolveDisplayNames(nameCacheObj, ids) {
  const all = Array.from(new Set((ids || []).filter(Boolean)));
  const need = all.filter((id) => !nameCacheObj[id]);
  if (!need.length) return nameCacheObj;

  const token = await getOAuthToken();
  const CHUNK = 50;
  for (let i = 0; i < need.length; i += CHUNK) {
    const batch = need.slice(i, i + CHUNK);
    const params = new URLSearchParams();
    for (const id of batch) params.append("accountId[]", id);

    try {
      const r = await fetchRetry(`https://api.trackmania.com/api/display-names?${params.toString()}`, {
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: "application/json",
          "User-Agent": "trackmaniaevents.com/weekly-shorts (github action)",
        },
      });

      if (!r.ok) {
        for (const id of batch) if (!nameCacheObj[id]) nameCacheObj[id] = id;
      } else {
        const j = await r.json(); // { "<accountId>": "DisplayName" }
        for (const id of batch) {
          const dn = j?.[id];
          nameCacheObj[id] = (typeof dn === "string" && dn) ? dn : id;
        }
      }
    } catch {
      for (const id of batch) if (!nameCacheObj[id]) nameCacheObj[id] = id;
    }
    await sleep(40);
  }

  return nameCacheObj;
}

/* ----------------------------- Weekly Shorts feed discovery ----------------------------- */
async function fetchWeeklyShortsCampaignWeeks(access) {
  const out = [];
  const LENGTH = 100;

  for (let offset = 0; offset <= 5000; offset += LENGTH) {
    const url = `${LIVE_BASE}/api/campaign/weekly-shorts?length=${LENGTH}&offset=${offset}`;
    const j = await jget(url, access);
    const list = Array.isArray(j?.campaignList) ? j.campaignList : [];
    if (!list.length) break;
    out.push(...list);
    if (list.length < LENGTH) break;
    await sleep(60);
  }

  return out;
}

function buildWeeksIndexFromWeeklyShortsFeed(weeksRaw) {
  const startMs = parseStartMs();

  const normalized = (weeksRaw || [])
    .map((w) => {
      const startTs = Number(w?.startTimestamp) || 0; // seconds
      const endTs = Number(w?.endTimestamp) || 0; // seconds
      const mapUids = (Array.isArray(w?.playlist) ? w.playlist : [])
        .map((p) => p?.mapUid)
        .filter(Boolean);

      // Campaign leaderboard group UID (points leaderboard for the whole week)
      const leaderboardGroupUid =
        w?.seasonUid ||
        w?.leaderboardGroupUid ||
        w?.leaderboardUid ||
        w?.leaderboardGroupId ||
        w?.leaderboardGroup?.uid ||
        w?.leaderboardGroup?.id ||
        w?.campaignLeaderboardGroupUid ||
        w?.leaderboard?.groupUid ||
        w?.leaderboard?.group?.uid ||
        null;

      return {
        year: w?.year ?? null,
        wsWeek: w?.week ?? null,
        startTs,
        endTs,
        mapUids,
        leaderboardGroupUid,
      };
    })
    .filter((w) => w.startTs > 0 && w.endTs > 0)
    .filter((w) => w.startTs * 1000 >= startMs)
    .sort((a, b) => a.startTs - b.startTs);

  const weeks = normalized.map((w, idx) => {
    const weekStartIso = new Date(w.startTs * 1000).toISOString();
    const endedAtIso = new Date(w.endTs * 1000 - 1).toISOString();

    return {
      week: idx + 1,
      year: w.year,
      wsWeek: w.wsWeek,
      weekStart: weekStartIso,
      endedAt: endedAtIso,
      leaderboardGroupUid: w.leaderboardGroupUid || null,
      mapUids: (w.mapUids || []).slice(0, WS_MAPS_PER_WEEK),
    };
  });

  return {
    generatedAt: isoNow(),
    startIso: WS_START_ISO,
    mapsPerWeek: WS_MAPS_PER_WEEK,
    weeks,
  };
}

/* ----------------------------- leaderboards ----------------------------- */
async function fetchWsTop(access, mapUid, length = 10) {
  const url =
    `${LIVE_BASE}/api/token/leaderboard/group/Personal_Best/map/${encodeURIComponent(mapUid)}` +
    `/top?onlyWorld=true&length=${length}&offset=0`;

  const j = await jget(url, access);
  const rows = j?.tops?.[0]?.top;
  const topArr = Array.isArray(rows) ? rows : [];

  return topArr
    .map((x, idx) => {
      const rank = Number(x.position ?? (idx + 1));
      const accountId = x.accountId;
      const timeMs = Number(x.score);
      if (!accountId || !isValidTimeMs(timeMs)) return null;
      return { rank, accountId, timeMs };
    })
    .filter(Boolean)
    .sort((a, b) => a.rank - b.rank);
}

async function fetchWsWeekPointsTop(access, leaderboardGroupUid, length = 10) {
  if (!leaderboardGroupUid) return [];
  const url =
    `${LIVE_BASE}/api/token/leaderboard/group/${encodeURIComponent(leaderboardGroupUid)}` +
    `/top?onlyWorld=true&offset=0&length=${length}`;

  const j = await jget(url, access);
  const rows = j?.tops?.[0]?.top;
  const arr = Array.isArray(rows) ? rows : [];

  return arr
    .map((x, idx) => {
      const rank = Number(x.position ?? (idx + 1));
      const accountId = x.accountId;
      const score = Number(x.score);
      if (!accountId || !Number.isFinite(score)) return null;
      return { rank, accountId, score };
    })
    .filter(Boolean)
    .sort((a, b) => a.rank - b.rank);
}

function buildAggregate(allWeekJson) {
  const by = new Map();

  for (const w of allWeekJson) {
    const weekNum = Number(w.week);

    // ---- WINS (highest weekly score)
    const sortedPoints = [...(w.entries || [])].sort(
      (a, b) => b.score - a.score
    );

    const winner = sortedPoints[0];

    if (winner) {
      const rec =
        by.get(winner.player) || {
          player: winner.player,
          wins: 0,
          wrs: 0,
          top5: 0,
          weeksWon: [],
          wrWeeks: [],
          top5Weeks: [],
        };

      rec.wins += 1;
      rec.weeksWon.push(weekNum);

      by.set(winner.player, rec);
    }

    // ---- MAP STATS
    for (const m of w.maps || []) {
      for (const e of m.entries || []) {
        const rec =
          by.get(e.player) || {
            player: e.player,
            wins: 0,
            wrs: 0,
            top5: 0,
            weeksWon: [],
            wrWeeks: [],
            top5Weeks: [],
          };

        if (e.rank === 1) {
          rec.wrs += 1;
          rec.wrWeeks.push({
            week: weekNum,
            mapUid: m.mapUid,
            timeMs: e.timeMs,
          });
        }

        if (e.rank <= 5) {
          rec.top5 += 1;
          rec.top5Weeks.push({
            week: weekNum,
            mapUid: m.mapUid,
            rank: e.rank,
            timeMs: e.timeMs,
          });
        }

        by.set(e.player, rec);
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

  return {
    generatedAt: new Date().toISOString(),
    players,
  };
}
/* ----------------------------- main ----------------------------- */
async function main() {
  ensureDir(WEEKS_DIR);

  const access = await getLiveAccessToken();
  const weeksRaw = await fetchWeeklyShortsCampaignWeeks(access);
  const weeksIndex = buildWeeksIndexFromWeeklyShortsFeed(weeksRaw);

  const nameCacheObj = readJson(NAME_CACHE_PATH, {});
  const changelog = readJson(CHANGELOG_PATH, { items: [] });

  const allWeekJson = [];

  for (const w of weeksIndex.weeks || []) {
    const maps = [];

    // Fetch map tops (for WR/top5 stats)
    for (const mapUid of w.mapUids || []) {
      const rows = await fetchWsTop(access, mapUid, MAP_TOP_LENGTH);
      await resolveDisplayNames(nameCacheObj, rows.map((r) => r.accountId));

      const entries = rows.map((r) => ({
        rank: r.rank,
        player: nameCacheObj[r.accountId] || r.accountId,
        timeMs: r.timeMs,
      }));

      maps.push({ mapUid, mapName: null, entries });
      await sleep(SLEEP_MS);
    }

    // Fetch points leaderboard (what tm.io shows)
    const pointsRows = await fetchWsWeekPointsTop(access, w.leaderboardGroupUid, POINTS_TOP_LENGTH);
    await resolveDisplayNames(nameCacheObj, pointsRows.map((r) => r.accountId));

    const pointsEntries = pointsRows.map((r) => ({
      rank: r.rank,
      player: nameCacheObj[r.accountId] || r.accountId,
      score: r.score,
    }));

    // Week JSON shape matches your HTML (entries = points)
    const weekJson = {
      week: w.week,
      year: w.year,
      wsWeek: w.wsWeek,
      weekStart: w.weekStart,
      endedAt: w.endedAt,
      entries: pointsEntries,

      // extra fields (ok if unused by HTML)
      mapUids: w.mapUids || [],
      maps,
      leaderboardGroupUid: w.leaderboardGroupUid || null,
    };

    allWeekJson.push(weekJson);
    writeJson(path.join(WEEKS_DIR, `${w.week}.json`), weekJson);
  }

  writeJson(WEEKS_INDEX_PATH, weeksIndex);
  writeJson(AGG_PATH, buildAggregate(allWeekJson));
  writeJson(CHANGELOG_PATH, changelog);
  writeJson(NAME_CACHE_PATH, nameCacheObj);

  console.log("[DONE] Weekly Shorts updated.");
  console.log("Weeks:", allWeekJson.length);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
