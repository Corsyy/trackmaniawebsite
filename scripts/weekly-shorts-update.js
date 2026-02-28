// scripts/weekly-shorts-update.js
// GitHub Pages generator for Weekly Shorts JSON
// - /data/weekly-shorts/weeks.json
// - /data/weekly-shorts/weeks/<week>.json
// - /data/weekly-shorts/aggregate.json
// - /data/weekly-shorts/name-cache.json

import fs from "node:fs";
import path from "node:path";

/* ========================= CONFIG ========================= */

const PUBLIC_DIR = process.env.PUBLIC_DIR || ".";
const BASE_DIR = path.join(process.cwd(), PUBLIC_DIR, "data", "weekly-shorts");
const WEEKS_DIR = path.join(BASE_DIR, "weeks");

const WEEKS_INDEX_PATH = path.join(BASE_DIR, "weeks.json");
const AGG_PATH = path.join(BASE_DIR, "aggregate.json");
const NAME_CACHE_PATH = path.join(BASE_DIR, "name-cache.json");

const LIVE_BASE = "https://live-services.trackmania.nadeo.live";
const CORE_REFRESH_URL =
  "https://prod.trackmania.core.nadeo.online/v2/authentication/token/refresh";

const OAUTH_CLIENT_ID = process.env.CLIENT_ID;
const OAUTH_CLIENT_SECRET = process.env.CLIENT_SECRET;
const REFRESH_TOKEN = cleanToken(process.env.REFRESH_TOKEN || "");

const DEBUG = String(process.env.DEBUG || "0") === "1";
const dlog = (...a) => DEBUG && console.log("[WS]", ...a);

const WS_START_ISO = String(process.env.WS_START_ISO || "1970-01-01T00:00:00Z").trim();
const WS_MAPS_PER_WEEK = Number(process.env.WS_MAPS_PER_WEEK || 5);

const MAP_TOP_LENGTH = Number(process.env.WS_MAP_TOP_LENGTH || 10);
const POINTS_TOP_LENGTH = Number(process.env.WS_POINTS_TOP_LENGTH || 10);

const SLEEP_MS = Number(process.env.WS_SLEEP_MS || 70);

/* ========================= HELPERS ========================= */

function cleanToken(s) {
  if (!s) return "";
  let t = String(s).trim();
  if (t.toLowerCase().startsWith("nadeo_v1 t=")) t = t.slice("nadeo_v1 t=".length).trim();
  if ((t.startsWith('"') && t.endsWith('"')) || (t.startsWith("'") && t.endsWith("'")))
    t = t.slice(1, -1);
  return t;
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

function isoNow() {
  return new Date().toISOString();
}

function parseStartMs() {
  const ms = Date.parse(WS_START_ISO);
  if (!Number.isFinite(ms)) throw new Error(`Invalid WS_START_ISO: ${WS_START_ISO}`);
  return ms;
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

// Robust number extraction (prevents NaN -> null in JSON)
function extractNumber(v) {
  if (typeof v === "number") return v;
  if (typeof v === "string") {
    const n = Number(v.replace(/,/g, ""));
    return Number.isFinite(n) ? n : NaN;
  }
  if (v && typeof v === "object") {
    // common nested shapes across endpoints/versions
    const keys = ["score", "points", "value", "val", "total", "result"];
    for (const k of keys) {
      if (k in v) {
        const n = extractNumber(v[k]);
        if (Number.isFinite(n)) return n;
      }
    }
  }
  return NaN;
}

function isValidTimeMs(ms) {
  return Number.isFinite(ms) && ms > 0 && ms < 24 * 3600 * 1000;
}

async function fetchRetry(url, opts = {}, retries = 5) {
  let lastErr;
  for (let i = 0; i <= retries; i++) {
    try {
      const r = await fetch(url, opts);
      if (r.status === 429 || (r.status >= 500 && r.status <= 599)) {
        await sleep(Math.min(400 * Math.pow(2, i), 8000));
        continue;
      }
      return r;
    } catch (e) {
      lastErr = e;
      await sleep(Math.min(400 * Math.pow(2, i), 8000));
    }
  }
  throw lastErr || new Error(`fetch failed: ${url}`);
}

/* ========================= AUTH ========================= */

let cachedLive = { token: null, expAt: 0 };

async function getLiveAccessToken() {
  if (cachedLive.token && Date.now() < cachedLive.expAt - 30000) return cachedLive.token;
  if (!REFRESH_TOKEN) throw new Error("Missing REFRESH_TOKEN");

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
    const t = await r.text().catch(() => "");
    throw new Error(`Token refresh failed: ${r.status} ${t}`);
  }

  const j = await r.json();
  cachedLive = {
    token: j.accessToken,
    expAt: Date.now() + (j.expiresIn || 3600) * 1000,
  };

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

/* ========================= OAUTH (display names) ========================= */

let cachedOAuth = { token: null, expAt: 0 };

async function getOAuthToken() {
  if (cachedOAuth.token && Date.now() < cachedOAuth.expAt - 30000) return cachedOAuth.token;

  if (!OAUTH_CLIENT_ID || !OAUTH_CLIENT_SECRET) {
    throw new Error("Missing CLIENT_ID / CLIENT_SECRET");
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

  if (!r.ok) {
    const t = await r.text().catch(() => "");
    throw new Error(`OAuth failed: ${r.status} ${t}`);
  }

  const j = await r.json();
  cachedOAuth = {
    token: j.access_token,
    expAt: Date.now() + (j.expires_in || 3600) * 1000,
  };

  return cachedOAuth.token;
}

async function resolveDisplayNames(cacheObj, ids) {
  const uniq = Array.from(new Set((ids || []).filter(Boolean)));
  const missing = uniq.filter((id) => !cacheObj[id]);
  if (!missing.length) return;

  const token = await getOAuthToken();
  const CHUNK = 50;

  for (let i = 0; i < missing.length; i += CHUNK) {
    const batch = missing.slice(i, i + CHUNK);
    const params = new URLSearchParams();
    for (const id of batch) params.append("accountId[]", id);

    const r = await fetchRetry(
      `https://api.trackmania.com/api/display-names?${params.toString()}`,
      { headers: { Authorization: `Bearer ${token}`, Accept: "application/json" } }
    );

    if (!r.ok) {
      for (const id of batch) cacheObj[id] = cacheObj[id] || id;
      continue;
    }

    const j = await r.json();
    for (const id of batch) cacheObj[id] = j?.[id] || id;

    await sleep(40);
  }
}

/* ========================= DISCOVER WEEKS ========================= */

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
      const startTs = Number(w?.startTimestamp) || 0;
      const endTs = Number(w?.endTimestamp) || 0;
      const mapUids = (Array.isArray(w?.playlist) ? w.playlist : [])
        .map((p) => p?.mapUid)
        .filter(Boolean);

      // IMPORTANT: include seasonUid fallback (some weeks use it)
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

/* ========================= LEADERBOARDS ========================= */

async function fetchMapTop(access, mapUid, length = 10) {
  const url =
    `${LIVE_BASE}/api/token/leaderboard/group/Personal_Best/map/${encodeURIComponent(mapUid)}` +
    `/top?onlyWorld=true&length=${length}&offset=0`;

  const j = await jget(url, access);
  const topArr = Array.isArray(j?.tops?.[0]?.top) ? j.tops[0].top : [];

  const parsed = topArr
    .map((x, idx) => {
      const rank = Number(x?.position ?? (idx + 1));
      const accountId = x?.accountId;
      const timeMs = extractNumber(x?.score);
      if (!accountId || !isValidTimeMs(timeMs)) return null;
      return { rank, accountId, timeMs };
    })
    .filter(Boolean)
    .sort((a, b) => a.rank - b.rank);

  return parsed;
}

/**
 * Weekly points leaderboard (what trackmania.io shows)
 * FIX: robust score extraction + we re-rank by score desc (don’t trust position)
 */
async function fetchWeekPoints(access, leaderboardGroupUid, length = 10) {
  if (!leaderboardGroupUid) return [];

  const url =
    `${LIVE_BASE}/api/token/leaderboard/group/${encodeURIComponent(leaderboardGroupUid)}` +
    `/top?onlyWorld=true&offset=0&length=${length}`;

  const j = await jget(url, access);
  const arr = Array.isArray(j?.tops?.[0]?.top) ? j.tops[0].top : [];

  if (DEBUG && arr.length) dlog("points row sample:", JSON.stringify(arr[0], null, 2));

  const rows = arr
    .map((x) => {
      const accountId = x?.accountId;
      const score = extractNumber(x?.score);
      if (!accountId || !Number.isFinite(score)) return null;
      return { accountId, score };
    })
    .filter(Boolean);

  // tm.io display = highest points first
  rows.sort((a, b) => b.score - a.score);

  // re-rank locally
  return rows.map((r, idx) => ({ rank: idx + 1, accountId: r.accountId, score: r.score }));
}

/* ========================= AGGREGATE ========================= */
/**
 * Your REQUIRED rules:
 * - Weekly leaderboard = points per week
 * - Wins = weekly points rank 1
 * - WRs = map rank 1
 * - Top5 = map rank <= 5
 */
function buildAggregate(allWeekJson) {
  const by = new Map();

  for (const w of allWeekJson) {
    const weekNum = Number(w.week);

    // Wins from POINTS rank 1
    const points = Array.isArray(w.entries) ? w.entries : [];
    const winner = points.find((p) => Number(p.rank) === 1);
    if (winner?.player) {
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

    // WR + Top5 from MAP leaderboards
    for (const m of w.maps || []) {
      const mapUid = m.mapUid;
      for (const e of m.entries || []) {
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

        if (Number(e.rank) === 1) {
          rec.wrs += 1;
          rec.wrWeeks.push({ week: weekNum, mapUid, timeMs: e.timeMs });
        }
        if (Number(e.rank) <= 5) {
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

  return { generatedAt: isoNow(), players };
}

/* ========================= MAIN ========================= */

async function main() {
  ensureDir(WEEKS_DIR);

  const access = await getLiveAccessToken();
  const weeksRaw = await fetchWeeklyShortsCampaignWeeks(access);
  const weeksIndex = buildWeeksIndexFromWeeklyShortsFeed(weeksRaw);

  const nameCacheObj = readJson(NAME_CACHE_PATH, {});
  const allWeekJson = [];

  for (const w of weeksIndex.weeks || []) {
    const maps = [];

    // Per-map leaderboards (WR / Top5)
    for (const mapUid of w.mapUids || []) {
      const rows = await fetchMapTop(access, mapUid, MAP_TOP_LENGTH);
      await resolveDisplayNames(nameCacheObj, rows.map((r) => r.accountId));

      const entries = rows.map((r) => ({
        rank: r.rank,
        player: nameCacheObj[r.accountId] || r.accountId,
        timeMs: r.timeMs,
      }));

      maps.push({ mapUid, mapName: null, entries });
      await sleep(SLEEP_MS);
    }

    // Weekly points leaderboard (rank + score)
    const points = await fetchWeekPoints(access, w.leaderboardGroupUid, POINTS_TOP_LENGTH);
    await resolveDisplayNames(nameCacheObj, points.map((r) => r.accountId));

    const pointsEntries = points.map((r) => ({
      rank: r.rank,
      player: nameCacheObj[r.accountId] || r.accountId,
      score: r.score,   // your HTML can display this
      points: r.score,  // also provide alias (some scripts used points)
    }));

    const weekJson = {
      week: w.week,
      year: w.year,
      wsWeek: w.wsWeek,
      weekStart: w.weekStart,
      endedAt: w.endedAt,

      // This is the weekly points leaderboard your table uses:
      entries: pointsEntries,

      // extra fields
      maps,
      mapUids: w.mapUids || [],
      leaderboardGroupUid: w.leaderboardGroupUid || null,
    };

    allWeekJson.push(weekJson);
    writeJson(path.join(WEEKS_DIR, `${w.week}.json`), weekJson);
  }

  writeJson(WEEKS_INDEX_PATH, weeksIndex);
  writeJson(AGG_PATH, buildAggregate(allWeekJson));
  writeJson(NAME_CACHE_PATH, nameCacheObj);

  console.log("[DONE] Weekly Shorts updated.");
  console.log("Weeks:", allWeekJson.length);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
