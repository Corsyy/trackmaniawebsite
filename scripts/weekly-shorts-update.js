// scripts/weekly-shorts-update.js
// Weekly Shorts campaign stats generator (auto names, auto changelog)
// Node 18+ (global fetch), ESM

import { mkdir, writeFile, readFile, access } from "node:fs/promises";
import { constants as FS } from "node:fs";
import path from "node:path";

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
const dlog = (...a) => { if (DEBUG) console.log("[WS]", ...a); };

const LIVE_BASE = "https://live-services.trackmania.nadeo.live";
const CORE_REFRESH_URL = "https://prod.trackmania.core.nadeo.online/v2/authentication/token/refresh";

// OAuth (api.trackmania.com)
const OAUTH_CLIENT_ID = process.env.CLIENT_ID;
const OAUTH_CLIENT_SECRET = process.env.CLIENT_SECRET;

// Live refresh token (nadeo_v1 refresh) — same as your Render server
const REFRESH_TOKEN = cleanToken(process.env.REFRESH_TOKEN || "");

/* ----------------------------- fs helpers ----------------------------- */
const ensureDir = (p) => mkdir(p, { recursive: true });
const exists = async (p) => { try { await access(p, FS.F_OK); return true; } catch { return false; } };
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

async function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

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
  // Same endpoint style you already use on Render:
  // GET https://api.trackmania.com/api/display-names?accountId[]=...
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

/* ----------------------------- weekly shorts fetch ----------------------------- */
function isValidTimeMs(ms) {
  return Number.isFinite(ms) && ms > 0 && ms < 24 * 3600 * 1000;
}

async function fetchMapTop(liveToken, mapUid, length = 10) {
  const groupUid = "Personal_Best";
  const url = `${LIVE_BASE}/api/token/leaderboard/group/${groupUid}/map/${encodeURIComponent(mapUid)}/top?onlyWorld=true&length=${length}`;
  const j = await jget(url, liveToken);

  // Your server code indicates: j.tops[0].top[0] for length=1
  // For length>1, typically j.tops[0].top is an array.
  const rows = j?.tops?.[0]?.top;
  if (!Array.isArray(rows) || !rows.length) return [];

  return rows
    .map((x, idx) => {
      const rank = (x.position ?? x.rank ?? x.pos ?? (idx + 1));
      const accountId = x.accountId;
      const timeMs = Number(x.score);
      if (!accountId || !isValidTimeMs(timeMs)) return null;
      return { rank, accountId, timeMs };
    })
    .filter(Boolean)
    .sort((a, b) => a.rank - b.rank);
}

function pickWinner(entries) {
  // Winner is rank 1; we treat that as "win"
  return entries.find(e => e.rank === 1) || entries[0] || null;
}

/* ----------------------------- aggregation ----------------------------- */
function buildAggregate(weeks) {
  const by = new Map();

  for (const w of weeks) {
    const weekNum = w.week;
    const mapUid = w.mapUid;

    for (const e of (w.entries || [])) {
      const name = e.player;
      if (!name) continue;

      if (!by.has(name)) {
        by.set(name, { player: name, wins: 0, wrs: 0, top5: 0, weeksWon: [], wrWeeks: [], top5Weeks: [] });
      }
      const p = by.get(name);

      if (e.rank === 1) {
        p.wins += 1;
        p.weeksWon.push(weekNum);
      }
      if (e.isWr) {
        p.wrs += 1;
        p.wrWeeks.push({ week: weekNum, mapUid, timeMs: e.timeMs });
      }
      if (e.rank <= 5) {
        p.top5 += 1;
        p.top5Weeks.push({ week: weekNum, mapUid, rank: e.rank, timeMs: e.timeMs });
      }
    }
  }

  const players = Array.from(by.values()).map(p => ({
    ...p,
    weeksWon: Array.from(new Set(p.weeksWon)).sort((a, b) => a - b),
  }));

  return { generatedAt: isoNow(), players };
}

/* ----------------------------- changelog logic ----------------------------- */
function ensureArray(x) { return Array.isArray(x) ? x : []; }

async function main() {
  await ensureDir(WEEKS_DIR);

  const weeksIndex = await loadJson(WEEKS_INDEX_PATH, null);
  if (!weeksIndex || !Array.isArray(weeksIndex.weeks)) {
    throw new Error(`Invalid ${WEEKS_INDEX_PATH}. Expected {"weeks":[{week,mapUid,endedAt,...}]}`);
  }

  // caches
  const nameCacheObj = await loadJson(NAME_CACHE_PATH, {});
  const snapshots = await loadJson(SNAPSHOT_PATH, {});
  const changelog = await loadJson(CHANGELOG_PATH, { items: [] });
  changelog.items = ensureArray(changelog.items);

  const liveToken = await getLiveAccessToken();

  const weekOutputs = [];

  for (const w of weeksIndex.weeks) {
    const weekNum = Number(w.week);
    const mapUid = w.mapUid;
    const mapName = w.mapName || `Week ${weekNum}`;
    const endedAt = w.endedAt || null;

    if (!weekNum || !mapUid) continue;

    // Top 10 for display; Top 5 used for stats anyway
    const rows = await fetchMapTop(liveToken, mapUid, 10);

    // Resolve names (auto)
    await resolveDisplayNames(nameCacheObj, rows.map(r => r.accountId));

    const entries = rows.map(r => ({
      rank: r.rank,
      player: nameCacheObj[r.accountId] || r.accountId,
      timeMs: r.timeMs,
      isWr: r.rank === 1,
      isWinner: r.rank === 1,
    }));

    const weekJson = {
      week: weekNum,
      mapUid,
      mapName,
      endedAt,
      entries,
    };

    await writeJson(`${WEEKS_DIR}/${weekNum}.json`, weekJson);
    weekOutputs.push(weekJson);

    // Post-week WR improvement detection (uses WR-at-end snapshot)
    if (endedAt) {
      const endedMs = new Date(endedAt).getTime();
      const now = Date.now();
      const wrNow = pickWinner(entries);

      if (wrNow && Number.isFinite(endedMs) && now >= endedMs) {
        const key = String(weekNum);
        const snap = snapshots[key];

        if (!snap) {
          // First time we run AFTER endedAt -> capture WR at end
          snapshots[key] = {
            week: weekNum,
            mapUid,
            mapName,
            endedAt,
            player: wrNow.player,
            timeMs: wrNow.timeMs,
            capturedAt: isoNow(),
          };
        } else {
          // If improved after end, log it and update snapshot
          if (Number(wrNow.timeMs) < Number(snap.timeMs)) {
            changelog.items.push({
              at: isoNow(),
              type: "WR_IMPROVED_AFTER_WEEK",
              week: weekNum,
              mapUid,
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

    await sleep(80); // be nice to endpoints
  }

  // Write caches
  await writeJson(NAME_CACHE_PATH, nameCacheObj);
  await writeJson(SNAPSHOT_PATH, snapshots);

  // Aggregate + changelog
  const agg = buildAggregate(weekOutputs);
  await writeJson(AGG_PATH, agg);

  changelog.items.sort((a, b) => new Date(b.at).getTime() - new Date(a.at).getTime());
  await writeJson(CHANGELOG_PATH, changelog);

  // Weeks index (optional: normalize output)
  await writeJson(WEEKS_INDEX_PATH, {
    generatedAt: isoNow(),
    weeks: weeksIndex.weeks,
  });

  console.log("[DONE] Weekly Shorts stats updated.");
  console.log("Wrote:", AGG_PATH);
  console.log("Wrote:", CHANGELOG_PATH);
  console.log("Weeks:", weekOutputs.length);
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
