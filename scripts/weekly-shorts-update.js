// scripts/weekly-shorts-update.js
// Weekly Shorts static generator (GitHub Pages compatible)

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

const MAP_TOP_LENGTH = Number(process.env.WS_MAP_TOP_LENGTH || 10);
const POINTS_TOP_LENGTH = Number(process.env.WS_POINTS_TOP_LENGTH || 50);

/* ========================= HELPERS ========================= */

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

function isoNow() {
  return new Date().toISOString();
}

/**
 * Robust numeric extraction:
 * - numbers stay numbers
 * - numeric strings parsed
 * - nested objects supported (common API shape changes)
 * Returns NaN if nothing usable found.
 */
function extractNumber(v) {
  if (typeof v === "number") return v;
  if (typeof v === "string") {
    const n = Number(v);
    return Number.isFinite(n) ? n : NaN;
  }
  if (v && typeof v === "object") {
    // Try common keys
    const keys = ["score", "points", "value", "val", "total", "rankedScore"];
    for (const k of keys) {
      if (k in v) {
        const n = extractNumber(v[k]);
        if (Number.isFinite(n)) return n;
      }
    }
  }
  return NaN;
}

/* ========================= AUTH ========================= */

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
  const r = await fetch(url, {
    headers: {
      Authorization: `nadeo_v1 t=${access}`,
      Accept: "application/json",
    },
  });

  if (!r.ok) throw new Error(`${url} -> ${r.status}`);
  return r.json();
}

/* ========================= OAUTH (display names) ========================= */

let cachedOAuth = { token: null, expAt: 0 };

async function getOAuthToken() {
  if (cachedOAuth.token && Date.now() < cachedOAuth.expAt - 30000)
    return cachedOAuth.token;

  if (!OAUTH_CLIENT_ID || !OAUTH_CLIENT_SECRET) {
    throw new Error("Missing CLIENT_ID / CLIENT_SECRET");
  }

  const r = await fetch("https://api.trackmania.com/api/access_token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "client_credentials",
      client_id: OAUTH_CLIENT_ID,
      client_secret: OAUTH_CLIENT_SECRET,
    }),
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

async function resolveDisplayNames(cache, ids) {
  const uniq = Array.from(new Set((ids || []).filter(Boolean)));
  const missing = uniq.filter((id) => !cache[id]);
  if (!missing.length) return;

  const token = await getOAuthToken();
  const params = new URLSearchParams();
  for (const id of missing) params.append("accountId[]", id);

  const r = await fetch(
    `https://api.trackmania.com/api/display-names?${params.toString()}`,
    { headers: { Authorization: `Bearer ${token}` } }
  );

  if (!r.ok) {
    // fallback: keep ids
    for (const id of missing) cache[id] = cache[id] || id;
    return;
  }

  const j = await r.json();
  for (const id of missing) cache[id] = j?.[id] || id;
}

/* ========================= LEADERBOARDS ========================= */

async function fetchMapTop(access, mapUid) {
  const url =
    `${LIVE_BASE}/api/token/leaderboard/group/Personal_Best/map/${encodeURIComponent(mapUid)}` +
    `/top?onlyWorld=true&length=${MAP_TOP_LENGTH}&offset=0`;

  const j = await jget(url, access);
  const rows = j?.tops?.[0]?.top || [];

  // timeMs is usually numeric, but keep robust anyway
  return rows
    .map((x) => {
      const timeMs = extractNumber(x?.score);
      const accountId = x?.accountId;
      if (!accountId || !Number.isFinite(timeMs)) return null;
      return { accountId, timeMs };
    })
    .filter(Boolean);
}

async function fetchPointsTop(access, leaderboardGroupUid) {
  if (!leaderboardGroupUid) return [];

  const url =
    `${LIVE_BASE}/api/token/leaderboard/group/${encodeURIComponent(leaderboardGroupUid)}` +
    `/top?onlyWorld=true&offset=0&length=${POINTS_TOP_LENGTH}`;

  const j = await jget(url, access);
  const rows = j?.tops?.[0]?.top || [];

  const mapped = rows
    .map((x) => {
      const accountId = x?.accountId;
      const score = extractNumber(x?.score);
      if (!accountId || !Number.isFinite(score)) return null;
      return { accountId, score };
    })
    .filter(Boolean);

  if (DEBUG && rows.length && !mapped.length) {
    dlog("Points rows exist but all scores invalid. Sample row:", rows[0]);
  }

  return mapped;
}

/* ========================= AGGREGATE ========================= */

function buildAggregate(allWeeks) {
  const by = new Map();

  for (const w of allWeeks) {
    const weekNum = Number(w.week);

    // Wins = highest weekly score
    const sortedPoints = [...(w.entries || [])].sort((a, b) => b.score - a.score);
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

    // WR / Top5 from per-map leaderboards
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
          rec.wrWeeks.push({ week: weekNum, mapUid: m.mapUid, timeMs: e.timeMs });
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

  return { generatedAt: isoNow(), players };
}

/* ========================= MAIN ========================= */

async function main() {
  ensureDir(WEEKS_DIR);

  const access = await getLiveAccessToken();
  const nameCache = readJson(NAME_CACHE_PATH, {});
  const weeksIndex = readJson(WEEKS_INDEX_PATH, { weeks: [] });

  const allWeeks = [];

  for (const w of weeksIndex.weeks || []) {
    const maps = [];

    // Map tops (WR/top5 stats)
    for (const mapUid of w.mapUids || []) {
      const rows = await fetchMapTop(access, mapUid);
      await resolveDisplayNames(nameCache, rows.map((r) => r.accountId));

      // sort best time first
      rows.sort((a, b) => a.timeMs - b.timeMs);

      const entries = rows.map((r, idx) => ({
        rank: idx + 1,
        player: nameCache[r.accountId] || r.accountId,
        timeMs: r.timeMs,
      }));

      maps.push({ mapUid, entries });
    }

    // Weekly points leaderboard
    const pointsRows = await fetchPointsTop(access, w.leaderboardGroupUid);
    await resolveDisplayNames(nameCache, pointsRows.map((r) => r.accountId));

    // sort by points desc
    pointsRows.sort((a, b) => b.score - a.score);

    const pointsEntries = pointsRows.map((r, idx) => ({
      rank: idx + 1,
      player: nameCache[r.accountId] || r.accountId,
      score: r.score, // <- if your HTML expects "points", rename to points here
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

    allWeeks.push(weekJson);
    writeJson(path.join(WEEKS_DIR, `${w.week}.json`), weekJson);
  }

  writeJson(AGG_PATH, buildAggregate(allWeeks));
  writeJson(NAME_CACHE_PATH, nameCache);

  console.log("[DONE] Weekly Shorts updated.");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
