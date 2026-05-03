// scripts/totd-fetcher.js — TOTD + TMX medal times & difficulty (keeps manual downloadUrl)
// Node 18+ (global fetch).
import fs from "node:fs";
import { mkdir, writeFile, readFile, access, readdir } from "node:fs/promises";
import { constants as FS } from "node:fs";
import path from "node:path";

/* ----------------------------- config/constants ---------------------------- */
const PUBLIC_DIR = process.env.PUBLIC_DIR || ".";
const TOTD_DIR = `${PUBLIC_DIR.replace(/\/+$/, "")}/data/totd`;
const TOTD_LATEST = `${PUBLIC_DIR.replace(/\/+$/, "")}/totd.json`;
const TOTD_LEADERBOARD_DIR = `${PUBLIC_DIR.replace(/\/+$/, "")}/data/totd-leaderboards`;
const TMIO = "https://trackmania.io";
const TMX_API = "https://trackmania.exchange/api"; // base for TMX API
const TMX_DL_BASE = "https://trackmania.exchange/maps/download";
const USER_AGENT = process.env.USER_AGENT || "tm-totd/1.1 (github action)";

const DEBUG = process.env.DEBUG === "1";
const dlog = (...a) => { if (DEBUG) console.log("[TOTD]", ...a); };

/* -------------------------------- fs helpers ------------------------------- */
const ensureDir = (p) => mkdir(p, { recursive: true });
const exists = async (p) => { try { await access(p, FS.F_OK); return true; } catch { return false; } };
const loadJson = async (p, f) => (await exists(p)) ? JSON.parse(await readFile(p, "utf8")) : f;
const writeJson = (p, obj) => writeFile(p, JSON.stringify(obj, null, 2), "utf8");

/* --------------------------------- utils ----------------------------------- */
const OAUTH_CLIENT_ID = process.env.CLIENT_ID;
const OAUTH_CLIENT_SECRET = process.env.CLIENT_SECRET;

let cachedOAuth = { token: null, expAt: 0 };
const pad2 = (n) => String(n).padStart(2, "0");
const monthKey = (y, m1) => `${y}-${pad2(m1)}`;
const dateKey = (y, m1, d) => `${y}-${pad2(m1)}-${pad2(d)}`;
function stripTmFormatting(input) {
    if (!input || typeof input !== "string") return input;
    const D = "\uFFF0";
    let s = input.replace(/\$\$/g, D);
    s = s.replace(/\$[0-9a-fA-F]{1,3}|\$[a-zA-Z]|\$[<>\[\]\(\)]/g, "");
    return s.replace(new RegExp(D, "g"), "$");
}
function tmioDayNumber(dayObj, idx) { return dayObj?.day ?? dayObj?.dayIndex ?? dayObj?.monthDay ?? dayObj?.dayInMonth ?? (idx + 1); }
let cachedLive = { token: null, expAt: 0 };

async function getLiveAccessToken() {
    const now = Date.now();
    if (cachedLive.token && now < cachedLive.expAt - 30_000) return cachedLive.token;

    const refreshToken = String(process.env.REFRESH_TOKEN || "").trim();
    if (!refreshToken) {
        throw new Error("REFRESH_TOKEN environment variable missing");
    }

    const res = await fetchRetry(
        "https://prod.trackmania.core.nadeo.online/v2/authentication/token/refresh",
        {
            method: "POST",
            headers: {
                Authorization: `nadeo_v1 t=${refreshToken}`,
                "User-Agent": "trackmaniaevents.com/totd (github action)",
                Accept: "application/json",
            },
        }
    );

    if (!res.ok) {
        const txt = await res.text().catch(() => "");
        throw new Error(`refresh token failed ${res.status} ${txt}`);
    }

    const data = await res.json();
    const accessToken = data?.accessToken || null;
    const newRefreshToken = data?.refreshToken || null;

    if (!accessToken) throw new Error("refresh response missing accessToken");

    try {
        const payload = JSON.parse(
            Buffer.from(accessToken.split(".")[1], "base64url").toString("utf8")
        );
        cachedLive = {
            token: accessToken,
            expAt: Number(payload?.exp || 0) * 1000 || Date.now() + 55 * 60 * 1000,
        };
    } catch {
        cachedLive = {
            token: accessToken,
            expAt: Date.now() + 55 * 60 * 1000,
        };
    }

    if (newRefreshToken && process.env.GITHUB_OUTPUT) {
        fs.appendFileSync(
            process.env.GITHUB_OUTPUT,
            `new_refresh_token=${newRefreshToken}\n`,
            "utf8"
        );
    }

    return accessToken;
}

async function liveGet(url, access) {
    const r = await fetchRetry(url, {
        headers: {
            Authorization: `nadeo_v1 t=${access}`,
            Accept: "application/json",
            "User-Agent": "trackmaniaevents.com/totd (github action)",
        },
    });

    if (!r.ok) throw new Error(`${url} -> ${r.status}`);
    return r.json();
}
async function fetchNadeoMapInfo(mapUid, access) {
    if (!mapUid || !access) return null;

    try {
        const url = `https://live-services.trackmania.nadeo.live/api/token/map/${encodeURIComponent(mapUid)}`;
        const j = await liveGet(url, access);

        return {
            authorTime: Number.isFinite(Number(j?.authorTime)) ? Number(j.authorTime) : null,
            goldTime: Number.isFinite(Number(j?.goldTime)) ? Number(j.goldTime) : null,
            silverTime: Number.isFinite(Number(j?.silverTime)) ? Number(j.silverTime) : null,
            bronzeTime: Number.isFinite(Number(j?.bronzeTime)) ? Number(j.bronzeTime) : null,
        };
    } catch (err) {
        dlog("Nadeo map info failed", mapUid, err?.message || err);
        return null;
    }
}
async function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
async function fetchRetry(url, opts = {}, retries = 5, baseDelay = 500) {
    let lastErr;
    for (let i = 0; i <= retries; i++) {
        try {
            const r = await fetch(url, { ...opts, headers: { "User-Agent": USER_AGENT, ...(opts.headers || {}) } });
            if (r.status === 429 || (r.status >= 500 && r.status <= 599)) {
                const wait = Math.min(baseDelay * Math.pow(2, i), 8000);
                if (DEBUG) dlog(`retry ${i} ${r.status} ${url} wait=${wait}ms`);
                await sleep(wait);
                continue;
            }
            return r;
        } catch (e) {
            lastErr = e;
            const wait = Math.min(baseDelay * Math.pow(2, i), 8000);
            if (DEBUG) dlog(`retry ${i} err ${e?.message || e} wait=${wait}ms`);
            await sleep(wait);
        }
    }
    throw lastErr || new Error(`fetch failed for ${url}`);
}

/* ------------------------------ tm.io helpers ------------------------------ */
async function fetchTmioMonth(index = 0) {
    const r = await fetchRetry(`${TMIO}/api/totd/${index}`);
    if (!r.ok) throw new Error(`tm.io totd[${index}] failed: ${r.status}`);
    return r.json();
}

/**
 * FIXED:
 * tm.io may return month as 1–12 (human) OR 0–11 (JS-style).
 * Old code always +1 which breaks Feb -> Mar.
 */
function tmioMonthYear(resp) {
    const y = resp?.month?.year ?? new Date().getUTCFullYear();
    const raw = resp?.month?.month;

    let m1;
    if (typeof raw === "number") {
        // if already 1-12, use it. else assume 0-11 and convert.
        m1 = (raw >= 1 && raw <= 12) ? raw : (raw + 1);
    } else {
        m1 = new Date().getUTCMonth() + 1;
    }

    return { y, m1 };
}

/* ------------------------------ TMX helpers --------------------------------
   We try TMX first: UID -> TMX map info (TrackID, medal times, difficulty, etc).
   If TMX lacks the map, we fall back to trackmania.io for a download.
-----------------------------------------------------------------------------*/
async function fetchTmxInfoByUid(uid) {
    if (!uid) return null;
    const url = `${TMX_API}/maps/get_map_info/uid/${encodeURIComponent(uid)}`;
    const r = await fetchRetry(url);
    if (!r.ok) { dlog("TMX uid lookup failed", uid, r.status); return null; }
    try {
        const j = await r.json();
        if (!j || typeof j !== "object") return null;
        if (j.TrackUID && j.TrackUID !== uid) return null;
        return j;
    } catch { return null; }
}

async function fetchTmxInfoById(trackId) {
    if (!trackId) return null;
    const url = `${TMX_API}/maps/get_map_info/id/${encodeURIComponent(trackId)}`;
    const r = await fetchRetry(url);
    if (!r.ok) return null;
    try {
        const j = await r.json();
        if (!j || typeof j !== "object") return null;
        if (!j.TrackID || String(j.TrackID) !== String(trackId)) return null;
        return j;
    } catch { return null; }
}

function tmxDownloadUrl(trackId, shortName) {
    const base = `${TMX_DL_BASE}/${encodeURIComponent(trackId)}`;
    return shortName ? `${base}?shortName=${encodeURIComponent(shortName)}` : base;
}

/* --------------------------- download & medals ----------------------------- */
function pickMedalFields(tmx) {
    // TMX returns ms times; Difficulty is an integer-ish category (0–5+).
    const toInt = v => (v == null ? null : Number(v));
    const diff = v => (v == null ? null : Number(v));
    return {
        authorTime: toInt(tmx?.AuthorTime),
        goldTime: toInt(tmx?.GoldTime),
        silverTime: toInt(tmx?.SilverTime),
        bronzeTime: toInt(tmx?.BronzeTime),
        difficulty: diff(tmx?.Difficulty)
    };
}

async function fetchMapDetails(mapUid) {
    if (!mapUid) return { downloadUrl: null, medals: null };

    // 1) Try TMX (prefer — gives us medals + difficulty + often a valid download)
    try {
        const tmx = await fetchTmxInfoByUid(mapUid);
        if (tmx && tmx.TrackID) {
            let shortName = tmx.ShortName || tmx.shortName || null;

            if ((tmx.Unlisted === true || tmx.Unlisted === 1) && !shortName) {
                const tmxById = await fetchTmxInfoById(tmx.TrackID);
                shortName = tmxById?.ShortName || tmxById?.shortName || null;
            }

            const downloadable = (tmx.Downloadable ?? true);
            const downloadUrl = downloadable ? tmxDownloadUrl(tmx.TrackID, shortName) : null;
            const medals = pickMedalFields(tmx);

            return { downloadUrl, medals };
        }
    } catch (e) {
        dlog("TMX resolver err", mapUid, e?.message || e);
    }

    // 2) Fallback to trackmania.io for a file URL (no medals here)
    try {
        const r = await fetchRetry(`${TMIO}/api/map/${encodeURIComponent(mapUid)}`);
        if (!r.ok) { dlog("tm.io map detail failed", mapUid, r.status); return { downloadUrl: null, medals: null }; }
        const j = await r.json();
        return { downloadUrl: j?.file || j?.download || null, medals: null };
    } catch (e) {
        dlog("tm.io resolver err", mapUid, e?.message || e);
        return { downloadUrl: null, medals: null };
    }
}

/* ------------------------------ month writing ------------------------------ */
async function rebuildMonthIndex(dir) {
    await ensureDir(dir);
    const items = await readdir(dir, { withFileTypes: true });
    const months = items
        .filter(e => e.isFile() && e.name.endsWith(".json") && e.name !== "months.json" && !e.name.startsWith("_"))
        .map(e => e.name.replace(/\.json$/, ""))
        .sort().reverse();
    await writeJson(path.join(dir, "months.json"), { months });
}

function baseDayRecord(y, m1, entry, idx) {
    const m = entry.map || entry;
    const uid = m.mapUid ?? entry.mapUid ?? null;
    let name = m.name ?? m.mapName ?? entry.name ?? "(unknown map)";
    let authorDisplayName = m.authorPlayer?.name ?? m.authorplayer?.name ?? m.authorName ?? m.author ?? entry.authorPlayer?.name ?? entry.authorplayer?.name ?? "(unknown)";
    const thumb = m.thumbnail ?? m.thumbnailUrl ?? entry.thumbnail ?? entry.thumbnailUrl ?? "";
    const authorAccountId = m.authorPlayer?.accountId ?? m.authorplayer?.accountid ?? entry.authorPlayer?.accountId ?? entry.authorplayer?.accountid ?? null;
    const d = tmioDayNumber(entry, idx);
    name = stripTmFormatting(name); authorDisplayName = stripTmFormatting(authorDisplayName);
    return {
        date: dateKey(y, m1, d),
        map: {
            uid, name, authorAccountId, authorDisplayName, thumbnailUrl: thumb,
            downloadUrl: null,
            authorTime: null, goldTime: null, silverTime: null, bronzeTime: null, difficulty: null
        }
    };
}
function extractNumber(v) {
  if (typeof v === "number") return v;

  if (typeof v === "string") {
    const n = Number(v.replace(/,/g, ""));
    return Number.isFinite(n) ? n : NaN;
  }

  if (v && typeof v === "object") {
    const keys = [
      "timeMs",
      "time",
      "bestTime",
      "personalBestTime",
      "recordTime",
      "score",
      "value",
      "best",
      "record",
    ];

    for (const k of keys) {
      if (k in v) {
        const n = extractNumber(v[k]);
        if (Number.isFinite(n)) return n;
      }
    }
  }

  return NaN;
}
async function getOAuthToken() {
  const now = Date.now();
  if (cachedOAuth.token && now < cachedOAuth.expAt - 30_000) return cachedOAuth.token;

  if (!OAUTH_CLIENT_ID || !OAUTH_CLIENT_SECRET) {
    throw new Error("Missing CLIENT_ID / CLIENT_SECRET env.");
  }

  const r = await fetchRetry("https://api.trackmania.com/api/access_token", {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      "User-Agent": "trackmaniaevents.com/totd",
    },
    body: new URLSearchParams({
      grant_type: "client_credentials",
      client_id: OAUTH_CLIENT_ID,
      client_secret: OAUTH_CLIENT_SECRET,
    }).toString(),
  });

  if (!r.ok) throw new Error(`oauth token failed ${r.status}`);

  const j = await r.json();
  const token = j.access_token || j.accessToken;
  const expiresIn = j.expires_in || 3600;

  if (!token) throw new Error("OAuth response missing access token");

  cachedOAuth = {
    token,
    expAt: Date.now() + expiresIn * 1000,
  };

  return token;
}

async function resolveDisplayNames(accountIds) {
  const ids = Array.from(new Set((accountIds || []).filter(Boolean)));
  if (!ids.length) return {};

  try {
    const token = await getOAuthToken();
    const out = {};

    for (let i = 0; i < ids.length; i += 50) {
      const batch = ids.slice(i, i + 50);
      const params = new URLSearchParams();

      for (const id of batch) {
        params.append("accountId[]", id);
      }

      const r = await fetchRetry(`https://api.trackmania.com/api/display-names?${params.toString()}`, {
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: "application/json",
          "User-Agent": "trackmaniaevents.com/totd",
        },
      });

      if (r.ok) {
        const j = await r.json();
        Object.assign(out, j);
      }
    }

    return out;
  } catch (err) {
    console.warn("[TOTD NAME RESOLVE FAILED]", err?.message || err);
    return {};
  }
}
async function fetchTotdLeaderboard(mapUid, access) {
  if (!mapUid || !access) return [];

  try {
    const url =
      `https://live-services.trackmania.nadeo.live/api/token/leaderboard/group/Personal_Best/map/${encodeURIComponent(mapUid)}` +
      `/top?onlyWorld=true&length=10&offset=0`;

    const j = await liveGet(url, access);
    const rows = Array.isArray(j?.tops?.[0]?.top) ? j.tops[0].top : [];

    console.log("[TOTD RAW LEADERBOARD]", mapUid, JSON.stringify(rows[0] || null));

    const parsed = rows
  .map((r, i) => ({
    rank: Number(r.position ?? r.rank ?? i + 1),
    accountId: r.accountId ?? null,
    player: r.displayName || r.name || r.accountId || "Unknown",
    timeMs: Number(
      r.timeMs ??
      r.time ??
      r.score?.timeMs ??
      r.score?.time ??
      r.score?.score ??
      r.score ??
      0
    ),
  }))
  .filter((r) => r.accountId && Number.isFinite(r.timeMs) && r.timeMs > 0)
  .sort((a, b) => a.rank - b.rank);

return parsed;
  } catch (err) {
    console.warn("[TOTD LEADERBOARD FAILED]", mapUid, err?.message || err);
    return [];
  }
}
async function writeTotdLeaderboard(mapUid, access) {
    if (!mapUid || !access) return;

    const rows = await fetchTotdLeaderboard(mapUid, access);
console.log("[TOTD LEADERBOARD WRITTEN]", mapUid, rows.length);
    await ensureDir(TOTD_LEADERBOARD_DIR);

    await writeJson(
        path.join(TOTD_LEADERBOARD_DIR, `${mapUid}.json`),
        {
            generatedAt: new Date().toISOString(),
            mapUid,
            rows,
        }
    );
}
async function writeTotdMonth(index = 0) {
    let liveAccess = null;

    try {
        liveAccess = await getLiveAccessToken();
    } catch (err) {
        dlog("Nadeo token unavailable:", err?.message || err);
    }
    // 0) load remote list
    const j = await fetchTmioMonth(index);
    const { y, m1 } = tmioMonthYear(j);
    const mKey = monthKey(y, m1);

    // Helpful debug log so you can see what month tm.io actually returned
    dlog("tm.io month resolved:", { index, rawMonth: j?.month?.month, year: y, m1, key: mKey });

    // 1) load existing month file (so manual overrides are preserved)
    const monthPath = path.join(TOTD_DIR, `${mKey}.json`);
    const prev = await loadJson(monthPath, { month: mKey, days: {} });
    const prevDays = prev?.days || {};
    const LIVE_BASE = "https://live-services.trackmania.nadeo.live";
    // 2) normalize remote -> day records
    const daysArr = (Array.isArray(j.days) ? j.days : []).map((entry, i) => baseDayRecord(y, m1, entry, i));

    // 3) hydrate each day with TMX medals/difficulty + download, preserving any manual downloadUrl
    for (const rec of daysArr) {
        const prevRec = prevDays[rec.date]?.map || {};
        // keep any manual/previous link
        if (prevRec.downloadUrl) {
            rec.map.downloadUrl = prevRec.downloadUrl;
        }
        // only fetch if we have a UID and no preserved link/medals yet
        if (rec.map.uid) {
            const { downloadUrl, medals } = await fetchMapDetails(rec.map.uid);
            if (!rec.map.downloadUrl) rec.map.downloadUrl = downloadUrl || null;
            if (medals) {
                rec.map.authorTime = medals.authorTime;
                rec.map.goldTime = medals.goldTime;
                rec.map.silverTime = medals.silverTime;
                rec.map.bronzeTime = medals.bronzeTime;
                rec.map.difficulty = medals.difficulty;
            }
            if (
                liveAccess &&
                rec.map.uid &&
                (
                    rec.map.authorTime == null ||
                    rec.map.goldTime == null ||
                    rec.map.silverTime == null ||
                    rec.map.bronzeTime == null
                )
            ) {
                const nadeo = await fetchNadeoMapInfo(rec.map.uid, liveAccess);

                if (nadeo) {
                    if (nadeo.authorTime) rec.map.authorTime = nadeo.authorTime;
                    if (nadeo.goldTime) rec.map.goldTime = nadeo.goldTime;
                    if (nadeo.silverTime) rec.map.silverTime = nadeo.silverTime;
                    if (nadeo.bronzeTime) rec.map.bronzeTime = nadeo.bronzeTime;
                }
            }
            if (liveAccess && rec.map.uid) {
                await writeTotdLeaderboard(rec.map.uid, liveAccess);
            }
            await sleep(120); // be nice to public APIs
        } else {
            // carry forward previously stored medals/difficulty if present
            rec.map.authorTime = prevRec.authorTime ?? rec.map.authorTime;
            rec.map.goldTime = prevRec.goldTime ?? rec.map.goldTime;
            rec.map.silverTime = prevRec.silverTime ?? rec.map.silverTime;
            rec.map.bronzeTime = prevRec.bronzeTime ?? rec.map.bronzeTime;
            rec.map.difficulty = prevRec.difficulty ?? rec.map.difficulty;
        }
    }

    // 4) write month file
    const daysOut = {}; for (const rec of daysArr) { daysOut[rec.date] = rec; }
    await ensureDir(TOTD_DIR);
    await writeJson(monthPath, { month: mKey, days: daysOut });
    await rebuildMonthIndex(TOTD_DIR);

    // 5) write latest snapshot
    const keys = Object.keys(daysOut).sort();
    const latestKey = keys[keys.length - 1] || null;
    if (latestKey) {
        const latest = daysOut[latestKey];
        await writeJson(TOTD_LATEST, { generatedAt: new Date().toISOString(), ...latest });
        dlog("latest:", latest.date, latest.map?.name, latest.map?.downloadUrl ? "[dl]" : "", "medals?",
            latest.map?.authorTime != null);
    } else {
        dlog("no days found for", mKey);
    }
}

/* ----------------------------------- main ---------------------------------- */
async function writeLeaderboardsForExistingTotdFiles(access) {
  if (!access) return;

  const files = await readdir(TOTD_DIR);

  const monthFiles = files.filter((file) =>
    file.endsWith(".json") &&
    file !== "months.json" &&
    !file.startsWith("_")
  );

  for (const file of monthFiles) {
    const fullPath = path.join(TOTD_DIR, file);
    const monthJson = await loadJson(fullPath, null);
    const days = monthJson?.days || {};

    for (const rec of Object.values(days)) {
      const uid = rec?.map?.uid;
      if (!uid) continue;

      console.log("[TOTD LEADERBOARD BACKFILL]", file, uid);
      await writeTotdLeaderboard(uid, access);
      await sleep(120);
    }
  }
}
async function debugCotdCompetitions() {
  try {
    const r = await fetchRetry(
      "https://meet.trackmania.nadeo.club/api/competitions?length=10&offset=0",
      {
        headers: {
          Accept: "application/json",
          "User-Agent": USER_AGENT,
        },
      }
    );

    if (!r.ok) {
      console.warn("[COTD DEBUG FAILED]", r.status);
      return;
    }

    const j = await r.json();

    console.log("[COTD DEBUG RESPONSE]", JSON.stringify(j).slice(0, 2000));
  } catch (err) {
    console.warn("[COTD DEBUG ERROR]", err?.message || err);
  }
}
async function writeCotdResultsPlaceholder() {
  await writeJson(`${TOTD_DIR}/cotd-results.json`, {
    generatedAt: new Date().toISOString(),
    mainWinner: null,
    status: "debug only - winner parser not added yet"
  });
}
async function debugCotdMatches(access, competitionId) {
  try {
    const url = `https://meet.trackmania.nadeo.club/api/competitions/${competitionId}/rounds/1/matches?length=5&offset=0`;

    const r = await fetchRetry(url, {
      headers: {
        Authorization: `nadeo_v1 t=${access}`,
        Accept: "application/json",
        "User-Agent": USER_AGENT,
      },
    });

    if (!r.ok) {
      console.warn("[COTD MATCHES DEBUG FAILED]", r.status, await r.text().catch(() => ""));
      return;
    }

    const j = await r.json();
    console.log("[COTD MATCHES DEBUG]", JSON.stringify(j, null, 2).slice(0, 6000));
  } catch (err) {
    console.warn("[COTD MATCHES DEBUG ERROR]", err?.message || err);
  }
}
async function main() {
  await ensureDir(TOTD_DIR);

  await writeTotdMonth(0);

  const access = await getLiveAccessToken();

  await debugCotdMatches(access, 42741);

  console.log("[DONE]");
}
main().catch(err => { console.error(err); process.exit(1); });
