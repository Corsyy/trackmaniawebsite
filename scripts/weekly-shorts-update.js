// scripts/weekly-shorts-update.js
// Generates static JSON for Weekly Shorts page (GitHub Pages friendly)

import fs from "node:fs";
import path from "node:path";

/* ----------------------------- config ----------------------------- */

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

const WS_START_ISO = String(process.env.WS_START_ISO || "2024-01-01T00:00:00Z").trim();
const WS_MAPS_PER_WEEK = Number(process.env.WS_MAPS_PER_WEEK || 5);
const MAP_TOP_LENGTH = Number(process.env.WS_MAP_TOP_LENGTH || 10);
const POINTS_TOP_LENGTH = Number(process.env.WS_POINTS_TOP_LENGTH || 10);

/* ----------------------------- helpers ----------------------------- */

function isoNow() {
  return new Date().toISOString();
}
function cleanToken(s) {
  if (!s) return "";
  let t = String(s).trim();
  if (t.toLowerCase().startsWith("nadeo_v1 t="))
    t = t.slice("nadeo_v1 t=".length).trim();
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
function parseStartMs() {
  const ms = Date.parse(WS_START_ISO);
  if (!Number.isFinite(ms)) throw new Error("Invalid WS_START_ISO");
  return ms;
}

/* ----------------------------- auth ----------------------------- */

let cachedLive = { token: null, expAt: 0 };

async function getLiveAccessToken() {
  if (cachedLive.token && Date.now() < cachedLive.expAt - 30000)
    return cachedLive.token;

  if (!REFRESH_TOKEN) throw new Error("Missing REFRESH_TOKEN");

  const r = await fetch(CORE_REFRESH_URL, {
    method: "POST",
    headers: {
      Authorization: `nadeo_v1 t=${REFRESH_TOKEN}`,
      "Content-Type": "application/json",
    },
    body: "{}",
  });

  if (!r.ok) throw new Error("Token refresh failed");

  const j = await r.json();
  cachedLive = {
    token: j.accessToken,
    expAt: Date.now() + (j.expiresIn || 3600) * 1000,
  };

  return cachedLive.token;
}

async function jget(url, access) {
  const r = await fetch(url, {
    headers: {
      Authorization: `nadeo_v1 t=${access}`,
      Accept: "application/json",
    },
  });
  if (!r.ok) throw new Error(`${url} -> ${r.status}`);
  return r.json();
}

/* ----------------------------- display names ----------------------------- */

let cachedOAuth = { token: null, expAt: 0 };

async function getOAuthToken() {
  if (cachedOAuth.token && Date.now() < cachedOAuth.expAt - 30000)
    return cachedOAuth.token;

  const r = await fetch("https://api.trackmania.com/api/access_token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "client_credentials",
      client_id: OAUTH_CLIENT_ID,
      client_secret: OAUTH_CLIENT_SECRET,
    }),
  });

  const j = await r.json();

  cachedOAuth = {
    token: j.access_token,
    expAt: Date.now() + (j.expires_in || 3600) * 1000,
  };

  return cachedOAuth.token;
}

async function resolveDisplayNames(cache, ids) {
  const missing = ids.filter((id) => !cache[id]);
  if (!missing.length) return;

  const token = await getOAuthToken();
  const params = new URLSearchParams();
  for (const id of missing) params.append("accountId[]", id);

  const r = await fetch(
    `https://api.trackmania.com/api/display-names?${params}`,
    { headers: { Authorization: `Bearer ${token}` } }
  );

  if (!r.ok) return;

  const j = await r.json();
  for (const id of missing) cache[id] = j[id] || id;
}

/* ----------------------------- leaderboard fetch ----------------------------- */

async function fetchWsTop(access, mapUid) {
  const url =
    `${LIVE_BASE}/api/token/leaderboard/group/Personal_Best/map/${mapUid}` +
    `/top?onlyWorld=true&length=${MAP_TOP_LENGTH}&offset=0`;

  const j = await jget(url, access);
  const rows = j?.tops?.[0]?.top || [];

  return rows.map((x) => ({
    accountId: x.accountId,
    timeMs: Number(x.score),
  }));
}

async function fetchWsWeekPointsTop(access, leaderboardGroupUid) {
  if (!leaderboardGroupUid) return [];

  const url =
    `${LIVE_BASE}/api/token/leaderboard/group/${leaderboardGroupUid}` +
    `/top?onlyWorld=true&offset=0&length=${POINTS_TOP_LENGTH}`;

  const j = await jget(url, access);
  const rows = j?.tops?.[0]?.top || [];

  return rows.map((x) => ({
    accountId: x.accountId,
    score: Number(x.score),
  }));
}

/* ----------------------------- aggregate ----------------------------- */

function buildAggregate(allWeekJson) {
  const by = new Map();

  for (const w of allWeekJson) {
    const weekNum = Number(w.week);

    // Wins = highest score per week
    const sortedPoints = [...w.entries].sort((a, b) => b.score - a.score);
    const winner = sortedPoints[0];

    if (winner) {
      const rec =
        by.get(winner.player) || {
          player: winner.player,
          wins: 0,
          wrs: 0,
          top5: 0,
        };
      rec.wins += 1;
      by.set(winner.player, rec);
    }

    for (const m of w.maps) {
      for (const e of m.entries) {
        const rec =
          by.get(e.player) || {
            player: e.player,
            wins: 0,
            wrs: 0,
            top5: 0,
          };

        if (e.rank === 1) rec.wrs += 1;
        if (e.rank <= 5) rec.top5 += 1;

        by.set(e.player, rec);
      }
    }
  }

  const players = Array.from(by.values()).sort(
    (a, b) =>
      b.wins - a.wins ||
      b.wrs - a.wrs ||
      b.top5 - a.top5 ||
      a.player.localeCompare(b.player)
  );

  return { generatedAt: isoNow(), players };
}

/* ----------------------------- main ----------------------------- */

async function main() {
  ensureDir(WEEKS_DIR);

  const access = await getLiveAccessToken();
  const nameCache = readJson(NAME_CACHE_PATH, {});

  const weeksIndex = readJson(WEEKS_INDEX_PATH, { weeks: [] });
  const allWeekJson = [];

  for (const w of weeksIndex.weeks || []) {
    const maps = [];

    for (const mapUid of w.mapUids || []) {
      const rows = await fetchWsTop(access, mapUid);
      await resolveDisplayNames(nameCache, rows.map((r) => r.accountId));

      const sorted = rows.sort((a, b) => a.timeMs - b.timeMs);

      const entries = sorted.map((r, idx) => ({
        rank: idx + 1,
        player: nameCache[r.accountId] || r.accountId,
        timeMs: r.timeMs,
      }));

      maps.push({ mapUid, entries });
    }

    // POINTS LEADERBOARD (corrected)
    const pointsRows = await fetchWsWeekPointsTop(
      access,
      w.leaderboardGroupUid
    );

    await resolveDisplayNames(nameCache, pointsRows.map((r) => r.accountId));

    // Sort by score descending
    pointsRows.sort((a, b) => b.score - a.score);

    const pointsEntries = pointsRows.map((r, idx) => ({
      rank: idx + 1,
      player: nameCache[r.accountId] || r.accountId,
      score: r.score,
    }));

    const weekJson = {
      week: w.week,
      year: w.year,
      wsWeek: w.wsWeek,
      weekStart: w.weekStart,
      endedAt: w.endedAt,
      entries: pointsEntries,
      maps,
      leaderboardGroupUid: w.leaderboardGroupUid || null,
    };

    allWeekJson.push(weekJson);
    writeJson(path.join(WEEKS_DIR, `${w.week}.json`), weekJson);
  }

  writeJson(AGG_PATH, buildAggregate(allWeekJson));
  writeJson(NAME_CACHE_PATH, nameCache);

  console.log("[DONE] Weekly Shorts updated.");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
