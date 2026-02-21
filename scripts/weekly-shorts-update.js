// scripts/weekly-shorts-update.js
// Weekly Shorts campaign stats generator (auto-discover official campaign + auto names + auto changelog)
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

// How we find the campaign:
const WS_MATCH = (process.env.WS_MATCH || "weekly shorts").toLowerCase().trim();
// Optional: pin an official campaign id if you want (recommended once you know it)
const WS_OFFICIAL_CAMPAIGN_ID = (process.env.WS_OFFICIAL_CAMPAIGN_ID || "").trim();
// Optional: pin a playlist id if the official list doesn’t include playlist (fallback)
const WS_OFFICIAL_PLAYLIST_ID = (process.env.WS_OFFICIAL_PLAYLIST_ID || "").trim();

const LIVE_BASE = "https://live-services.trackmania.nadeo.live";
const CORE_REFRESH_URL = "https://prod.trackmania.core.nadeo.online/v2/authentication/token/refresh";

// OAuth (api.trackmania.com)
const OAUTH_CLIENT_ID = process.env.CLIENT_ID;
const OAUTH_CLIENT_SECRET = process.env.CLIENT_SECRET;

// Live refresh token (nadeo_v1 refresh)
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

/* ---------------------- Weekly Shorts discovery (OFFICIAL) ---------------------- */

function getCampaignId(obj) {
  return obj?.id || obj?.campaignId || obj?.campaign?.id || null;
}
function getCampaignName(obj) {
  return obj?.name || obj?.campaignName || obj?.campaign?.name || "";
}
function getPlaylist(obj) {
  // official list often includes playlist; support a few shapes
  const pl =
    obj?.playlist ||
    obj?.campaign?.playlist ||
    obj?.campaign?.campaignPlaylist ||
    obj?.campaignPlaylist ||
    null;
  return Array.isArray(pl) ? pl : null;
}

async function fetchOfficialCampaigns(liveToken) {
  const url = `${LIVE_BASE}/api/campaign/official?offset=0&length=200`;
  const j = await jget(url, liveToken);
  const list = j?.campaignList || j?.campaigns || [];
  return Array.isArray(list) ? list : [];
}

async function fetchPlaylistById(liveToken, playlistId) {
  // Fallback endpoint — not always necessary. If this 404s in your environment, just rely on the list playlist.
  const url = `${LIVE_BASE}/api/token/playlist/${encodeURIComponent(playlistId)}`;
  const j = await jget(url, liveToken);
  const pl = j?.playlist || j?.maps || j?.campaign?.playlist;
  return Array.isArray(pl) ? pl : [];
}

function normalizePlaylistMaps(playlistArr) {
  // Each item usually has mapUid; name can be missing
  return (playlistArr || [])
    .map((x) => ({
      mapUid: x?.mapUid || x?.uid || x?.map?.mapUid || null,
      mapName: x?.name || x?.mapName || x?.map?.name || null,
    }))
    .filter((x) => x.mapUid);
}

async function discoverWeeksIndex(liveToken) {
  const official = await fetchOfficialCampaigns(liveToken);

  let chosen = null;

  if (WS_OFFICIAL_CAMPAIGN_ID) {
    chosen = official.find((c) => String(getCampaignId(c)) === String(WS_OFFICIAL_CAMPAIGN_ID)) || null;
    if (!chosen) {
      throw new Error(`WS_OFFICIAL_CAMPAIGN_ID=${WS_OFFICIAL_CAMPAIGN_ID} was not found in official campaigns list.`);
    }
  } else {
    // best-effort name match
    const matches = official.filter((c) => getCampaignName(c).toLowerCase().includes(WS_MATCH));
    chosen = matches[0] || null;
    if (!chosen) {
      const sample = official.slice(0, 10).map((c) => getCampaignName(c)).filter(Boolean);
      throw new Error(
        `Could not find an OFFICIAL campaign matching "${WS_MATCH}". ` +
        `Set WS_OFFICIAL_CAMPAIGN_ID to pin it. Sample official names: ${sample.join(" | ")}`
      );
    }
  }

  let playlistArr = getPlaylist(chosen);

  // If playlist isn't present in list response, optionally fetch by playlist id.
  if ((!playlistArr || !playlistArr.length) && WS_OFFICIAL_PLAYLIST_ID) {
    dlog("Official campaign list had no playlist; fetching playlist by id:", WS_OFFICIAL_PLAYLIST_ID);
    playlistArr = await fetchPlaylistById(liveToken, WS_OFFICIAL_PLAYLIST_ID);
  }

  const maps = normalizePlaylistMaps(playlistArr);
  if (!maps.length) {
    throw new Error(
      `Found official campaign "${getCampaignName(chosen)}" but could not read its playlist. ` +
      `Try setting WS_OFFICIAL_PLAYLIST_ID, or paste a debug response so we can adapt the shape.`
    );
  }

  // Merge with existing weeks.json so endedAt persists (and we can auto-end the previous last week)
  const prev = await loadJson(WEEKS_INDEX_PATH, null);
  const prevWeeks = Array.isArray(prev?.weeks) ? prev.weeks : [];

  const prevByWeek = new Map(prevWeeks.map((w) => [Number(w.week), w]));
  const prevMax = prevWeeks.reduce((m, w) => Math.max(m, Number(w.week) || 0), 0);

  const nextWeeks = maps.map((m, idx) => {
    const week = idx + 1;
    const old = prevByWeek.get(week);
    return {
      week,
      mapUid: m.mapUid,
      mapName: m.mapName || old?.mapName || `Week ${week}`,
      endedAt: old?.endedAt || null,
    };
  });

  // If playlist grew, auto-set endedAt on the previous last week (first time we notice a new week exists)
  const nextMax = nextWeeks.length;
  if (prevMax > 0 && nextMax > prevMax) {
    const lastPrev = nextWeeks.find((w) => Number(w.week) === prevMax);
    if (lastPrev && !lastPrev.endedAt) {
      lastPrev.endedAt = isoNow();
      dlog(`Auto-ended week ${prevMax} at ${lastPrev.endedAt} because a new week appeared.`);
    }
  }

  const out = {
    generatedAt: isoNow(),
    campaign: getCampaignName(chosen) || "Weekly Shorts",
    game: "Trackmania 2020",
    campaignId: String(getCampaignId(chosen) || ""),
    weeks: nextWeeks,
  };

  await writeJson(WEEKS_INDEX_PATH, out);
  return out;
}

/* ----------------------------- weekly shorts fetch ----------------------------- */
function isValidTimeMs(ms) {
  return Number.isFinite(ms) && ms > 0 && ms < 24 * 3600 * 1000;
}

async function fetchMapTop(liveToken, mapUid, length = 10) {
  const groupUid = "Personal_Best";
  const url = `${LIVE_BASE}/api/token/leaderboard/group/${groupUid}/map/${encodeURIComponent(mapUid)}/top?onlyWorld=true&length=${length}`;
  const j = await jget(url, liveToken);

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

  // Sort strongest first
  players.sort((a, b) => (b.wins - a.wins) || (b.wrs - a.wrs) || (b.top5 - a.top5) || a.player.localeCompare(b.player));

  return { generatedAt: isoNow(), players };
}

/* ----------------------------- changelog logic ----------------------------- */
function ensureArray(x) { return Array.isArray(x) ? x : []; }

async function main() {
  await ensureDir(WEEKS_DIR);

  const liveToken = await getLiveAccessToken();

  // ✅ Auto-create / refresh weeks.json if missing or invalid
  let weeksIndex = await loadJson(WEEKS_INDEX_PATH, null);
  if (!weeksIndex || !Array.isArray(weeksIndex.weeks) || !weeksIndex.weeks.length) {
    dlog("weeks.json missing/invalid — discovering Weekly Shorts from OFFICIAL campaigns…");
    weeksIndex = await discoverWeeksIndex(liveToken);
  } else {
    // Also refresh it every run so new weeks appear automatically
    weeksIndex = await discoverWeeksIndex(liveToken);
  }

  // caches
  const nameCacheObj = await loadJson(NAME_CACHE_PATH, {});
  const snapshots = await loadJson(SNAPSHOT_PATH, {});
  const changelog = await loadJson(CHANGELOG_PATH, { items: [] });
  changelog.items = ensureArray(changelog.items);

  const weekOutputs = [];

  for (const w of weeksIndex.weeks) {
    const weekNum = Number(w.week);
    const mapUid = w.mapUid;
    const mapName = w.mapName || `Week ${weekNum}`;
    const endedAt = w.endedAt || null;

    if (!weekNum || !mapUid) continue;

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

    // Post-week WR improvement detection (only runs if endedAt is known)
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

    await sleep(80);
  }

  // Write caches
  await writeJson(NAME_CACHE_PATH, nameCacheObj);
  await writeJson(SNAPSHOT_PATH, snapshots);

  // Aggregate + changelog
  const agg = buildAggregate(weekOutputs);
  await writeJson(AGG_PATH, agg);

  changelog.items.sort((a, b) => new Date(b.at).getTime() - new Date(a.at).getTime());
  await writeJson(CHANGELOG_PATH, changelog);

  // Normalize weeks index output
  await writeJson(WEEKS_INDEX_PATH, {
    generatedAt: isoNow(),
    campaign: weeksIndex.campaign || "Weekly Shorts",
    game: "Trackmania 2020",
    campaignId: weeksIndex.campaignId || "",
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
