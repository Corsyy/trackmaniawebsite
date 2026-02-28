// scripts/weekly-shorts-update.js
// Weekly Shorts stats generator (Weekly Shorts feed + week points leaderboard + map tops)
// Node 18+ (global fetch), ESM

import { mkdir, writeFile, readFile, access } from "node:fs/promises";
import { constants as FS } from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

/* ----------------------------- config ----------------------------- */
const PUBLIC_DIR = process.env.PUBLIC_DIR || ".";
const BASE_DIR = `${PUBLIC_DIR.replace(/\/+$/, "")}/data/weekly-shorts`;
const WEEKS_INDEX_PATH = `${BASE_DIR}/weeks.json`;
const WEEKS_DIR = `${BASE_DIR}/weeks`;

const NAME_CACHE_PATH = `${BASE_DIR}/name-cache.json`;
const SNAPSHOT_PATH = `${BASE_DIR}/wr-end-snapshots.json`;
const CHANGELOG_PATH = `${BASE_DIR}/changelog.json`;
const AGG_PATH = `${BASE_DIR}/aggregate.json`;

const DEBUG = process.env.DEBUG === "1";
const dlog = (...a) => {
  if (DEBUG) console.log("[WS]", ...a);
};

const LIVE_BASE = "https://live-services.trackmania.nadeo.live";
const CORE_REFRESH_URL = "https://prod.trackmania.core.nadeo.online/v2/authentication/token/refresh";

// OAuth (api.trackmania.com)
const OAUTH_CLIENT_ID = process.env.CLIENT_ID;
const OAUTH_CLIENT_SECRET = process.env.CLIENT_SECRET;

// Live refresh token (nadeo_v1 refresh)
const REFRESH_TOKEN = cleanToken(process.env.REFRESH_TOKEN || "");

/**
 * Optional: if you want to exclude old weeks (or fix “start not changing” issues),
 * set WS_START_ISO in GitHub Action env OR here.
 * Note: env overrides code.
 */
const WS_START_ISO = String(process.env.WS_START_ISO || "2024-01-01T00:00:00Z").trim();

/**
 * Concurrency/tuning
 */
const MAP_TOP_LENGTH = Number(process.env.WS_MAP_TOP_LENGTH || 10); // per-map top length
const POINTS_TOP_LENGTH = Number(process.env.WS_POINTS_TOP_LENGTH || 10); // weekly points top length
const FETCH_SLEEP_MS = Number(process.env.WS_SLEEP_MS || 80);

/* ----------------------------- fs helpers ----------------------------- */
const ensureDir = (p) => mkdir(p, { recursive: true });
const exists = async (p) => {
  try {
    await access(p, FS.F_OK);
    return true;
  } catch {
    return false;
  }
};
const loadJson = async (p, fallback) => (await exists(p)) ? JSON.parse(await readFile(p, "utf8")) : fallback;
const writeJson = async (p, obj) => {
  await ensureDir(path.dirname(p));
  await writeFile(p, JSON.stringify(obj, null, 2) + "\n", "utf8");
};

/* ----------------------------- utils ----------------------------- */
function cleanToken(s) {
  if (!s) return "";
  let t = String(s).trim();
  if (t.toLowerCase().startsWith("nadeo_v1 t=")) t = t.slice("nadeo_v1 t=".length).trim();
  if ((t.startsWith('"') && t.endsWith('"')) || (t.startsWith("'") && t.endsWith("'"))) t = t.slice(1, -1);
  return t;
}

const isoNow = () => new Date().toISOString();

async function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function toIsoFromSeconds(sec) {
  const n = Number(sec);
  if (!Number.isFinite(n) || n <= 0) return null;
  return new Date(n * 1000).toISOString();
}

function parseStartMs() {
  const ms = Date.parse(WS_START_ISO);
  if (!Number.isFinite(ms)) throw new Error(`Invalid WS_START_ISO: ${WS_START_ISO}`);
  return ms;
}

async function fetchWithTimeout(url, opts = {}, ms = 15000) {
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), ms);
  try {
    return await fetch(url, { ...opts, signal: ac.signal });
  } finally {
    clearTimeout(t);
  }
}

async function fetchRetry(url, opts = {}, retries = 5, baseDelay = 400) {
  let lastErr;
  for (let i = 0; i <= retries; i++) {
    try {
      const r = await fetchWithTimeout(url, opts, 15000);
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

/* ----------------------------- auth: Nadeo Live ----------------------------- */
let cachedLive = { token: null, expAt: 0 };

async function getLiveAccessToken() {
  const now = Date.now();
  if (cachedLive.token && now < cachedLive.expAt - 30_000) return cachedLive.token;

  if (!REFRESH_TOKEN) {
    throw new Error("Missing REFRESH_TOKEN env (Nadeo refresh token).");
  }

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

async function jget(url, liveAccessToken) {
  const r = await fetchRetry(url, {
    headers: {
      Authorization: `nadeo_v1 t=${liveAccessToken}`,
      Accept: "application/json",
      "User-Agent": "trackmaniaevents.com/weekly-shorts (github action)",
    },
  });
  if (!r.ok) throw new Error(`${url} -> ${r.status}`);
  return r.json();
}

/* ----------------------------- auth: OAuth names ----------------------------- */
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

  const oToken = await getOAuthToken();
  const CHUNK = 50;

  for (let i = 0; i < need.length; i += CHUNK) {
    const batch = need.slice(i, i + CHUNK);
    const params = new URLSearchParams();
    for (const id of batch) params.append("accountId[]", id);

    try {
      const r = await fetchRetry(`https://api.trackmania.com/api/display-names?${params.toString()}`, {
        headers: {
          Authorization: `Bearer ${oToken}`,
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

/* ---------------------- Weekly Shorts discovery (WEEKLY-SHORTS FEED) ---------------------- */

async function fetchWeeklyShortsCampaignWeeks(liveToken) {
  const out = [];
  const LENGTH = 100;

  for (let offset = 0; offset <= 5000; offset += LENGTH) {
    const url = `${LIVE_BASE}/api/campaign/weekly-shorts?length=${LENGTH}&offset=${offset}`;
    const j = await jget(url, liveToken);
    const list = Array.isArray(j?.campaignList) ? j.campaignList : [];
    if (!list.length) break;
    out.push(...list);
    if (list.length < LENGTH) break;
    await sleep(40);
  }
  return out;
}

function normalizeWeekObj(w) {
  const startTs = Number(w?.startTimestamp) || 0; // seconds
  const endTs = Number(w?.endTimestamp) || 0; // seconds

  const playlist = Array.isArray(w?.playlist) ? w.playlist : [];
  const mapUids = playlist.map((p) => p?.mapUid).filter(Boolean);

  // This is the important piece for weekly points leaderboard:
  // some responses include seasonUid, some include a group uid field.
  const groupUid =
    w?.seasonUid ||
    w?.leaderboardGroupUid ||
    w?.leaderboardGroup?.uid ||
    w?.leaderboard?.groupUid ||
    null;

  return {
    year: w?.year ?? null,
    wsWeek: w?.week ?? null,
    startTs,
    endTs,
    weekStart: toIsoFromSeconds(startTs),
    endedAt: endTs ? new Date(endTs * 1000 - 1).toISOString() : null,
    mapUids,
    pointsGroupUid: groupUid,
  };
}

async function buildWeeksIndex(liveToken) {
  const startMs = parseStartMs();
  const raw = await fetchWeeklyShortsCampaignWeeks(liveToken);

  const normalized = raw
    .map(normalizeWeekObj)
    .filter((w) => w.startTs > 0 && w.endTs > 0 && w.weekStart && w.endedAt)
    .filter((w) => (w.startTs * 1000) >= startMs)
    .sort((a, b) => a.startTs - b.startTs);

  const weeks = normalized.map((w, idx) => ({
    week: idx + 1,
    year: w.year,
    wsWeek: w.wsWeek,
    weekStart: w.weekStart,
    endedAt: w.endedAt,
    mapUids: w.mapUids,
    pointsGroupUid: w.pointsGroupUid || null,
  }));

  return {
    generatedAt: isoNow(),
    campaign: "Weekly Shorts",
    game: "Trackmania 2020",
    startIso: WS_START_ISO,
    weeks,
  };
}

/* ----------------------------- leaderboard fetch ----------------------------- */
function isValidTimeMs(ms) {
  return Number.isFinite(ms) && ms > 0 && ms < 24 * 3600 * 1000;
}

async function fetchMapTop(liveToken, mapUid, length = 10) {
  const groupUid = "Personal_Best";
  const url = `${LIVE_BASE}/api/token/leaderboard/group/${groupUid}/map/${encodeURIComponent(mapUid)}/top?onlyWorld=true&length=${length}&offset=0`;
  const j = await jget(url, liveToken);

  const rows = j?.tops?.[0]?.top;
  if (!Array.isArray(rows) || !rows.length) return [];

  return rows
    .map((x, idx) => {
      const rank = Number(x.position ?? x.rank ?? x.pos ?? (idx + 1));
      const accountId = x.accountId;
      const timeMs = Number(x.score);
      if (!accountId || !isValidTimeMs(timeMs)) return null;
      return { rank, accountId, timeMs };
    })
    .filter(Boolean)
    .sort((a, b) => a.rank - b.rank);
}

async function fetchWeekPointsTop(liveToken, groupUid, length = 10) {
  if (!groupUid) return [];

  const url = `${LIVE_BASE}/api/token/leaderboard/group/${encodeURIComponent(groupUid)}/top?onlyWorld=true&length=${length}&offset=0`;
  const j = await jget(url, liveToken);

  const rows = j?.tops?.[0]?.top;
  if (!Array.isArray(rows) || !rows.length) return [];

  return rows
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

function pickWinnerFromMapEntries(entries) {
  return entries.find((e) => e.rank === 1) || entries[0] || null;
}

/* ----------------------------- aggregation (map-based stats) ----------------------------- */
function buildAggregate(weekOutputs) {
  const by = new Map();

  for (const w of weekOutputs) {
    const weekNum = w.week;

    // ----- WINS from weekly POINTS leaderboard -----
    const points = Array.isArray(w.points) ? w.points : [];
    const winner = points.find(p => p.rank === 1);
    if (winner) {
      const name = winner.player;
      if (!by.has(name)) {
        by.set(name, { player: name, wins: 0, wrs: 0, top5: 0, weeksWon: [] });
      }
      const p = by.get(name);
      p.wins += 1;
      p.weeksWon.push(weekNum);
    }

    // ----- WRs + Top5s from MAP leaderboards -----
    for (const map of (w.maps || [])) {
      for (const e of (map.entries || [])) {
        const name = e.player;
        if (!name) continue;

        if (!by.has(name)) {
          by.set(name, { player: name, wins: 0, wrs: 0, top5: 0, weeksWon: [] });
        }

        const p = by.get(name);

        if (e.rank === 1) {
          p.wrs += 1;   // map WR
        }

        if (e.rank <= 5) {
          p.top5 += 1;
        }
      }
    }
  }

  const players = Array.from(by.values()).map(p => ({
    ...p,
    weeksWon: Array.from(new Set(p.weeksWon)).sort((a,b)=>a-b),
  }));

  players.sort(
    (a,b) =>
      (b.wins - a.wins) ||
      (b.wrs - a.wrs) ||
      (b.top5 - a.top5) ||
      a.player.localeCompare(b.player)
  );

  return { generatedAt: isoNow(), players };
}

/* ----------------------------- changelog logic (WR improved after week ended) ----------------------------- */
function ensureArray(x) {
  return Array.isArray(x) ? x : [];
}

async function main() {
  await ensureDir(WEEKS_DIR);

  const liveToken = await getLiveAccessToken();

  // Build weeks index from Weekly Shorts feed (no “OFFICIAL” discovery)
  const weeksIndex = await buildWeeksIndex(liveToken);

  // caches
  const nameCacheObj = await loadJson(NAME_CACHE_PATH, {});
  const snapshots = await loadJson(SNAPSHOT_PATH, {});
  const changelog = await loadJson(CHANGELOG_PATH, { items: [] });
  changelog.items = ensureArray(changelog.items);

  const weekOutputs = [];

  for (const w of weeksIndex.weeks) {
    const weekNum = Number(w.week);
    const endedAt = w.endedAt || null;

    // Fetch weekly points top10
    const pointsRows = await fetchWeekPointsTop(liveToken, w.pointsGroupUid, POINTS_TOP_LENGTH);
    await resolveDisplayNames(nameCacheObj, pointsRows.map((r) => r.accountId));
    const points = pointsRows.map((r) => ({
      rank: r.rank,
      player: nameCacheObj[r.accountId] || r.accountId,
      score: r.score,
    }));

    // Fetch per-map top10 times (for the week’s maps)
    const maps = [];
    for (const mapUid of (w.mapUids || [])) {
      const rows = await fetchMapTop(liveToken, mapUid, MAP_TOP_LENGTH);
      await resolveDisplayNames(nameCacheObj, rows.map((r) => r.accountId));

      const entries = rows.map((r) => ({
        rank: r.rank,
        player: nameCacheObj[r.accountId] || r.accountId,
        timeMs: r.timeMs,
        isWr: r.rank === 1,
        isWinner: r.rank === 1,
      }));

      maps.push({
        mapUid,
        mapName: null,
        entries,
      });

      await sleep(40);
    }

    const weekJson = {
      week: weekNum,
      year: w.year ?? null,
      wsWeek: w.wsWeek ?? null,
      weekStart: w.weekStart || null,
      endedAt,
      pointsGroupUid: w.pointsGroupUid || null,

      // This is what your website should use for the Week Leaderboard:
      points, // [{rank, player, score}]

      // Keep maps for the “Most WRs / Top5” style stats:
      maps,
    };

    await writeJson(`${WEEKS_DIR}/${weekNum}.json`, weekJson);
    weekOutputs.push(weekJson);

    // Post-week WR improvement detection (based on first map’s WR)
    if (endedAt && maps.length) {
      const endedMs = new Date(endedAt).getTime();
      const now = Date.now();
      const wrNow = pickWinnerFromMapEntries(maps[0].entries);

      if (wrNow && Number.isFinite(endedMs) && now >= endedMs) {
        const key = String(weekNum);
        const snap = snapshots[key];

        if (!snap) {
          snapshots[key] = {
            week: weekNum,
            mapUid: maps[0].mapUid,
            mapName: maps[0].mapName || `Week ${weekNum} Map 1`,
            endedAt,
            player: wrNow.player,
            timeMs: wrNow.timeMs,
            capturedAt: isoNow(),
          };
        } else {
          if (Number(wrNow.timeMs) < Number(snap.timeMs)) {
            changelog.items.push({
              at: isoNow(),
              type: "WR_IMPROVED_AFTER_WEEK",
              week: weekNum,
              mapUid: maps[0].mapUid,
              playerNew: wrNow.player,
              timeNewMs: wrNow.timeMs,
              playerPrev: snap.player,
              timePrevMs: snap.timeMs,
            });

            snapshots[key] = {
              ...snap,
              player: wrNow.player,
              timeMs: wrNow.timeMs,
              capturedAt: isoNow(),
            };
          }
        }
      }
    }

    await sleep(FETCH_SLEEP_MS);
  }

  // Write caches
  await writeJson(NAME_CACHE_PATH, nameCacheObj);
  await writeJson(SNAPSHOT_PATH, snapshots);

  // Aggregate + changelog
  const agg = buildAggregate(weekOutputs);
  await writeJson(AGG_PATH, agg);

  changelog.items.sort((a, b) => new Date(b.at).getTime() - new Date(a.at).getTime());
  await writeJson(CHANGELOG_PATH, changelog);

  // weeks.json (static index for website)
  // Keep a compact shape, but include weekStart/endedAt (and mapUids)
  const weeksOut = {
    generatedAt: isoNow(),
    campaign: weeksIndex.campaign || "Weekly Shorts",
    game: "Trackmania 2020",
    startIso: WS_START_ISO,
    weeks: weeksIndex.weeks.map((w) => ({
      week: w.week,
      year: w.year ?? null,
      wsWeek: w.wsWeek ?? null,
      weekStart: w.weekStart || null,
      endedAt: w.endedAt || null,
      mapUids: w.mapUids || [],
    })),
  };
  await writeJson(WEEKS_INDEX_PATH, weeksOut);

  console.log("[DONE] Weekly Shorts stats updated.");
  console.log("Wrote:", WEEKS_INDEX_PATH);
  console.log("Wrote:", AGG_PATH);
  console.log("Wrote:", CHANGELOG_PATH);
  console.log("Weeks:", weekOutputs.length);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
