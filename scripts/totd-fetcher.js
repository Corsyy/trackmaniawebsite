// scripts/totd-fetcher.js
// TOTD month data + TMX medals/difficulty/download + top 10 leaderboards.
// Node 18+ required for global fetch.

import fs from "node:fs";
import { mkdir, writeFile, readFile, access, readdir } from "node:fs/promises";
import { constants as FS } from "node:fs";
import path from "node:path";

/* ----------------------------- config/constants ---------------------------- */

const PUBLIC_DIR = process.env.PUBLIC_DIR || ".";
const PUBLIC_ROOT = PUBLIC_DIR.replace(/\/+$/, "");

const TOTD_DIR = `${PUBLIC_ROOT}/data/totd`;
const TOTD_LATEST = `${PUBLIC_ROOT}/totd.json`;
const TOTD_LEADERBOARD_DIR = `${PUBLIC_ROOT}/data/totd-leaderboards`;

const TMIO = "https://trackmania.io";
const TMX_API = "https://trackmania.exchange/api";
const TMX_DL_BASE = "https://trackmania.exchange/maps/download";
const LIVE_BASE = "https://live-services.trackmania.nadeo.live";

const USER_AGENT = process.env.USER_AGENT || "trackmaniaevents.com/totd-fetcher";
const DEBUG = process.env.DEBUG === "1";

const OAUTH_CLIENT_ID = process.env.CLIENT_ID;
const OAUTH_CLIENT_SECRET = process.env.CLIENT_SECRET;

/* ---------------------------------- logs ---------------------------------- */

const dlog = (...a) => {
  if (DEBUG) console.log("[TOTD]", ...a);
};

/* -------------------------------- fs helpers ------------------------------- */

const ensureDir = (p) => mkdir(p, { recursive: true });

const exists = async (p) => {
  try {
    await access(p, FS.F_OK);
    return true;
  } catch {
    return false;
  }
};

const loadJson = async (p, fallback) => {
  if (!(await exists(p))) return fallback;
  return JSON.parse(await readFile(p, "utf8"));
};

const writeJson = (p, obj) => writeFile(p, JSON.stringify(obj, null, 2), "utf8");

/* --------------------------------- utils ---------------------------------- */

const pad2 = (n) => String(n).padStart(2, "0");
const monthKey = (y, m1) => `${y}-${pad2(m1)}`;
const dateKey = (y, m1, d) => `${y}-${pad2(m1)}-${pad2(d)}`;

function stripTmFormatting(input) {
  if (!input || typeof input !== "string") return input;

  const D = "\uFFF0";
  let s = input.replace(/\$\$/g, D);
  s = s.replace(/\$[0-9a-fA-F]{1,3}|\$[a-zA-Z]|\$[<>\[\]\(\)]/g, "");

  return s.replace(new RegExp(D, "g"), "$").trim();
}

async function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function fetchRetry(url, opts = {}, retries = 5, baseDelay = 500) {
  let lastErr;

  for (let i = 0; i <= retries; i++) {
    try {
      const r = await fetch(url, {
        ...opts,
        headers: {
          "User-Agent": USER_AGENT,
          ...(opts.headers || {}),
        },
      });

      if (r.status === 429 || (r.status >= 500 && r.status <= 599)) {
        const wait = Math.min(baseDelay * Math.pow(2, i), 8000);
        dlog(`retry ${i} ${r.status} ${url} wait=${wait}ms`);
        await sleep(wait);
        continue;
      }

      return r;
    } catch (e) {
      lastErr = e;
      const wait = Math.min(baseDelay * Math.pow(2, i), 8000);
      dlog(`retry ${i} err ${e?.message || e} wait=${wait}ms`);
      await sleep(wait);
    }
  }

  throw lastErr || new Error(`fetch failed for ${url}`);
}

/* ------------------------------- Nadeo auth -------------------------------- */

let cachedLive = { token: null, expAt: 0 };

async function getLiveAccessToken() {
  const now = Date.now();
  if (cachedLive.token && now < cachedLive.expAt - 30_000) {
    return cachedLive.token;
  }

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
    },
  });

  if (!r.ok) {
    const txt = await r.text().catch(() => "");
    throw new Error(`${url} -> ${r.status} ${txt}`);
  }

  return r.json();
}

/* ----------------------------- OAuth names API ----------------------------- */

let cachedOAuth = { token: null, expAt: 0 };

async function getOAuthToken() {
  const now = Date.now();
  if (cachedOAuth.token && now < cachedOAuth.expAt - 30_000) {
    return cachedOAuth.token;
  }

  if (!OAUTH_CLIENT_ID || !OAUTH_CLIENT_SECRET) {
    throw new Error("Missing CLIENT_ID / CLIENT_SECRET env.");
  }

  const r = await fetchRetry("https://api.trackmania.com/api/access_token", {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams({
      grant_type: "client_credentials",
      client_id: OAUTH_CLIENT_ID,
      client_secret: OAUTH_CLIENT_SECRET,
    }).toString(),
  });

  if (!r.ok) {
    const txt = await r.text().catch(() => "");
    throw new Error(`oauth token failed ${r.status} ${txt}`);
  }

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

      const r = await fetchRetry(
        `https://api.trackmania.com/api/display-names?${params.toString()}`,
        {
          headers: {
            Authorization: `Bearer ${token}`,
            Accept: "application/json",
          },
        }
      );

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

/* ------------------------------- Nadeo TOTD -------------------------------- */

function normalizeNadeoMonthNumber(rawMonth) {
  const n = Number(rawMonth);

  // Current Nadeo campaign/month data appears to use 1-12.
  // Keep this conservative so we do not shift already-good historical months.
  if (Number.isFinite(n) && n >= 1 && n <= 12) return n;

  return new Date().getUTCMonth() + 1;
}

async function fetchNadeoTotdMonths(access, length = 36, offset = 0) {
  const url =
    `${LIVE_BASE}/api/token/campaign/month` +
    `?length=${encodeURIComponent(length)}` +
    `&offset=${encodeURIComponent(offset)}`;

  const j = await liveGet(url, access);

  return Array.isArray(j?.monthList) ? j.monthList : [];
}

function getNadeoDaysRaw(monthObj) {
  return (
    monthObj.days ||
    monthObj.mapList ||
    monthObj.maps ||
    monthObj.campaignList ||
    []
  );
}

function pickUid(entry) {
  return (
    entry?.mapUid ??
    entry?.uid ??
    entry?.map?.mapUid ??
    entry?.map?.uid ??
    entry?.mapInfo?.mapUid ??
    entry?.mapInfo?.uid ??
    ""
  );
}

function pickInitialMapName(entry) {
  return stripTmFormatting(
    entry?.name ??
      entry?.mapName ??
      entry?.map?.name ??
      entry?.mapInfo?.name ??
      "(unknown map)"
  );
}

function pickInitialAuthorName(entry) {
  return stripTmFormatting(
    entry?.author ??
      entry?.authorName ??
      entry?.authorDisplayName ??
      entry?.map?.author ??
      entry?.map?.authorName ??
      entry?.mapInfo?.authorName ??
      "(unknown)"
  );
}

function baseNadeoDayRecord(monthObj, entry, idx) {
  const y = Number(monthObj.year);
  const m1 = normalizeNadeoMonthNumber(monthObj.month);

  // Important:
  // In Nadeo month data, entry.day can be day-of-week, not day-of-month.
  // The TOTD entries are already ordered, so index + 1 is the correct month day.
  const d = idx + 1;

  const uid = pickUid(entry);

  return {
    date: dateKey(y, m1, d),
    map: {
      uid,
      name: pickInitialMapName(entry),
      authorAccountId:
        entry?.authorAccountId ??
        entry?.map?.authorAccountId ??
        entry?.mapInfo?.authorAccountId ??
        null,
      authorDisplayName: pickInitialAuthorName(entry),
      thumbnailUrl:
        entry?.thumbnailUrl ??
        entry?.thumbnail ??
        entry?.map?.thumbnailUrl ??
        entry?.map?.thumbnail ??
        entry?.mapInfo?.thumbnailUrl ??
        "",
      downloadUrl: null,
      authorTime: null,
      goldTime: null,
      silverTime: null,
      bronzeTime: null,
      difficulty: null,
    },
  };
}

/* ------------------------------- TMX helpers ------------------------------- */

async function fetchTmxInfoByUid(uid) {
  if (!uid) return null;

  const url = `${TMX_API}/maps/get_map_info/uid/${encodeURIComponent(uid)}`;
  const r = await fetchRetry(url);

  if (!r.ok) {
    dlog("TMX uid lookup failed", uid, r.status);
    return null;
  }

  try {
    const j = await r.json();
    if (!j || typeof j !== "object") return null;
    if (j.TrackUID && j.TrackUID !== uid) return null;
    return j;
  } catch {
    return null;
  }
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
  } catch {
    return null;
  }
}

function tmxDownloadUrl(trackId, shortName) {
  const base = `${TMX_DL_BASE}/${encodeURIComponent(trackId)}`;
  return shortName ? `${base}?shortName=${encodeURIComponent(shortName)}` : base;
}

function pickMedalFields(tmx) {
  const toInt = (v) => (v == null ? null : Number(v));
  const diff = (v) => (v == null ? null : Number(v));

  return {
    authorTime: toInt(tmx?.AuthorTime),
    goldTime: toInt(tmx?.GoldTime),
    silverTime: toInt(tmx?.SilverTime),
    bronzeTime: toInt(tmx?.BronzeTime),
    difficulty: diff(tmx?.Difficulty),
  };
}

function pickTmxMapName(tmx) {
  return stripTmFormatting(
    tmx?.Name ??
      tmx?.GbxMapName ??
      tmx?.TrackName ??
      tmx?.MapName ??
      ""
  );
}

function pickTmxAuthorName(tmx) {
  return stripTmFormatting(
    tmx?.Username ??
      tmx?.UserName ??
      tmx?.AuthorLogin ??
      tmx?.Author ??
      ""
  );
}

async function fetchMapDetails(mapUid) {
  if (!mapUid) {
    return {
      downloadUrl: null,
      medals: null,
      name: null,
      authorDisplayName: null,
      thumbnailUrl: null,
    };
  }

  try {
    const tmx = await fetchTmxInfoByUid(mapUid);

    if (tmx && tmx.TrackID) {
      let shortName = tmx.ShortName || tmx.shortName || null;

      if ((tmx.Unlisted === true || tmx.Unlisted === 1) && !shortName) {
        const tmxById = await fetchTmxInfoById(tmx.TrackID);
        shortName = tmxById?.ShortName || tmxById?.shortName || null;
      }

      const downloadable = tmx.Downloadable ?? true;
      const downloadUrl = downloadable ? tmxDownloadUrl(tmx.TrackID, shortName) : null;
      const medals = pickMedalFields(tmx);

      return {
        downloadUrl,
        medals,
        name: pickTmxMapName(tmx) || null,
        authorDisplayName: pickTmxAuthorName(tmx) || null,
        thumbnailUrl: tmx?.ThumbnailUrl ?? tmx?.ImageUrl ?? null,
      };
    }
  } catch (e) {
    dlog("TMX resolver err", mapUid, e?.message || e);
  }

  try {
    const r = await fetchRetry(`${TMIO}/api/map/${encodeURIComponent(mapUid)}`);

    if (!r.ok) {
      dlog("tm.io map detail failed", mapUid, r.status);
      return {
        downloadUrl: null,
        medals: null,
        name: null,
        authorDisplayName: null,
        thumbnailUrl: null,
      };
    }

    const j = await r.json();

    return {
      downloadUrl: j?.file || j?.download || null,
      medals: null,
      name: stripTmFormatting(j?.name || j?.mapName || "") || null,
      authorDisplayName:
        stripTmFormatting(j?.author || j?.authorName || j?.username || "") || null,
      thumbnailUrl: j?.thumbnail || j?.thumbnailUrl || null,
    };
  } catch (e) {
    dlog("tm.io resolver err", mapUid, e?.message || e);

    return {
      downloadUrl: null,
      medals: null,
      name: null,
      authorDisplayName: null,
      thumbnailUrl: null,
    };
  }
}

/* ----------------------------- Nadeo map info ------------------------------ */

async function fetchNadeoMapInfo(mapUid, access) {
  if (!mapUid || !access) return null;

  try {
    const url = `${LIVE_BASE}/api/token/map/${encodeURIComponent(mapUid)}`;
    const j = await liveGet(url, access);

    return {
      authorTime: Number.isFinite(Number(j?.authorTime)) ? Number(j.authorTime) : null,
      goldTime: Number.isFinite(Number(j?.goldTime)) ? Number(j.goldTime) : null,
      silverTime: Number.isFinite(Number(j?.silverTime)) ? Number(j.silverTime) : null,
      bronzeTime: Number.isFinite(Number(j?.bronzeTime)) ? Number(j.bronzeTime) : null,
      name: stripTmFormatting(j?.name || j?.mapName || "") || null,
      authorDisplayName:
        stripTmFormatting(j?.author || j?.authorName || j?.authorDisplayName || "") ||
        null,
      thumbnailUrl: j?.thumbnailUrl || j?.thumbnail || null,
    };
  } catch (err) {
    dlog("Nadeo map info failed", mapUid, err?.message || err);
    return null;
  }
}

/* ------------------------------ month writing ------------------------------ */

async function rebuildMonthIndex(dir) {
  await ensureDir(dir);

  const items = await readdir(dir, { withFileTypes: true });

  const months = items
    .filter(
      (e) =>
        e.isFile() &&
        e.name.endsWith(".json") &&
        e.name !== "months.json" &&
        !e.name.startsWith("_")
    )
    .map((e) => e.name.replace(/\.json$/, ""))
    .sort()
    .reverse();

  await writeJson(path.join(dir, "months.json"), { months });
}

async function writeNadeoTotdMonth(monthObj, liveAccess) {
  const y = Number(monthObj.year);
  const m1 = normalizeNadeoMonthNumber(monthObj.month);
  const mKey = monthKey(y, m1);

  const monthPath = path.join(TOTD_DIR, `${mKey}.json`);
  const prev = await loadJson(monthPath, { month: mKey, days: {} });
  const prevDays = prev?.days || {};

  const daysRaw = getNadeoDaysRaw(monthObj);

  const daysArr = daysRaw
    .map((entry, i) => baseNadeoDayRecord(monthObj, entry, i))
    // This removes empty future rows and prevents bad 2026-05-00 style records.
    .filter((rec) => rec.map.uid);

  for (const rec of daysArr) {
    const prevRec = prevDays[rec.date]?.map || {};

    if (prevRec.downloadUrl) rec.map.downloadUrl = prevRec.downloadUrl;
    if (prevRec.thumbnailUrl && !rec.map.thumbnailUrl) rec.map.thumbnailUrl = prevRec.thumbnailUrl;

    const details = await fetchMapDetails(rec.map.uid);

    if (!rec.map.downloadUrl) {
      rec.map.downloadUrl = details.downloadUrl || null;
    }

    if (!rec.map.name || rec.map.name === "(unknown map)") {
      rec.map.name = details.name || rec.map.name;
    }

    if (!rec.map.authorDisplayName || rec.map.authorDisplayName === "(unknown)") {
      rec.map.authorDisplayName = details.authorDisplayName || rec.map.authorDisplayName;
    }

    if (!rec.map.thumbnailUrl) {
      rec.map.thumbnailUrl = details.thumbnailUrl || "";
    }

    if (details.medals) {
      rec.map.authorTime = details.medals.authorTime;
      rec.map.goldTime = details.medals.goldTime;
      rec.map.silverTime = details.medals.silverTime;
      rec.map.bronzeTime = details.medals.bronzeTime;
      rec.map.difficulty = details.medals.difficulty;
    }

    if (
      liveAccess &&
      (
        rec.map.authorTime == null ||
        rec.map.goldTime == null ||
        rec.map.silverTime == null ||
        rec.map.bronzeTime == null ||
        !rec.map.name ||
        rec.map.name === "(unknown map)"
      )
    ) {
      const nadeo = await fetchNadeoMapInfo(rec.map.uid, liveAccess);

      if (nadeo) {
        if (nadeo.authorTime) rec.map.authorTime = nadeo.authorTime;
        if (nadeo.goldTime) rec.map.goldTime = nadeo.goldTime;
        if (nadeo.silverTime) rec.map.silverTime = nadeo.silverTime;
        if (nadeo.bronzeTime) rec.map.bronzeTime = nadeo.bronzeTime;
        if ((!rec.map.name || rec.map.name === "(unknown map)") && nadeo.name) {
          rec.map.name = nadeo.name;
        }
        if (
          (!rec.map.authorDisplayName || rec.map.authorDisplayName === "(unknown)") &&
          nadeo.authorDisplayName
        ) {
          rec.map.authorDisplayName = nadeo.authorDisplayName;
        }
        if (!rec.map.thumbnailUrl && nadeo.thumbnailUrl) {
          rec.map.thumbnailUrl = nadeo.thumbnailUrl;
        }
      }
    }

    await writeTotdLeaderboard(rec.map.uid, liveAccess);
    await sleep(120);
  }

  const daysOut = {};
  for (const rec of daysArr) {
    daysOut[rec.date] = rec;
  }

  await ensureDir(TOTD_DIR);
  await writeJson(monthPath, { month: mKey, days: daysOut });
  await rebuildMonthIndex(TOTD_DIR);

  return { mKey, daysOut };
}

async function writeLatestSnapshotFromNewestMonth() {
  const files = await readdir(TOTD_DIR);

  const monthFiles = files
    .filter((f) => f.endsWith(".json") && f !== "months.json" && !f.startsWith("_"))
    .map((f) => f.replace(/\.json$/, ""))
    .sort()
    .reverse();

  for (const mKey of monthFiles) {
    const monthJson = await loadJson(path.join(TOTD_DIR, `${mKey}.json`), null);
    const days = monthJson?.days || {};
    const keys = Object.keys(days).sort();

    if (!keys.length) continue;

    const latestKey = keys[keys.length - 1];
    const latest = days[latestKey];

    await writeJson(TOTD_LATEST, {
      generatedAt: new Date().toISOString(),
      ...latest,
    });

    dlog(
      "latest:",
      latest.date,
      latest.map?.name,
      latest.map?.downloadUrl ? "[dl]" : "",
      "medals?",
      latest.map?.authorTime != null
    );

    return;
  }

  dlog("no TOTD days found for latest snapshot");
}

/* ------------------------------- leaderboards ------------------------------ */

async function fetchTotdLeaderboard(mapUid, access) {
  if (!mapUid || !access) return [];

  try {
    const url =
      `${LIVE_BASE}/api/token/leaderboard/group/Personal_Best/map/${encodeURIComponent(
        mapUid
      )}/top?onlyWorld=true&length=10&offset=0`;

    const j = await liveGet(url, access);
    const rows = Array.isArray(j?.tops?.[0]?.top) ? j.tops[0].top : [];

    const accountIds = rows.map((r) => r.accountId).filter(Boolean);
    const namesById = await resolveDisplayNames(accountIds);

    const parsed = rows
      .map((r, i) => {
        const accountId = r.accountId ?? null;

        return {
          rank: Number(r.position ?? r.rank ?? i + 1),
          accountId,
          player: stripTmFormatting(
            namesById[accountId] ||
              r.displayName ||
              r.name ||
              accountId ||
              "Unknown"
          ),
          timeMs: Number(
            r.timeMs ??
              r.time ??
              r.score?.timeMs ??
              r.score?.time ??
              r.score?.score ??
              r.score ??
              0
          ),
        };
      })
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

  await writeJson(path.join(TOTD_LEADERBOARD_DIR, `${mapUid}.json`), {
    generatedAt: new Date().toISOString(),
    mapUid,
    rows,
  });
}

/* ----------------------------------- main ---------------------------------- */

async function main() {
  await ensureDir(TOTD_DIR);
  await ensureDir(TOTD_LEADERBOARD_DIR);

  const access = await getLiveAccessToken();

  const MONTHS_TO_FETCH = Number(process.env.TOTD_MONTHS_TO_FETCH || 36);
  const FORCE_REBUILD = process.env.FORCE_TOTD_REBUILD === "1";

  const months = await fetchNadeoTotdMonths(access, MONTHS_TO_FETCH, 0);

  if (!months.length) {
    throw new Error("No TOTD months returned from Nadeo campaign/month endpoint");
  }

  for (let i = 0; i < months.length; i++) {
    const monthObj = months[i];
    const mKey = monthKey(
      Number(monthObj.year),
      normalizeNadeoMonthNumber(monthObj.month)
    );

    const monthPath = path.join(TOTD_DIR, `${mKey}.json`);
    const isCurrentMonth = i === 0;
    const alreadyExists = await exists(monthPath);

    if (!FORCE_REBUILD && !isCurrentMonth && alreadyExists) {
      console.log("[TOTD MONTH SKIPPED]", mKey);
      continue;
    }

    console.log("[TOTD MONTH FETCH]", i, mKey);
    await writeNadeoTotdMonth(monthObj, access);
    await sleep(500);
  }

  await rebuildMonthIndex(TOTD_DIR);
  await writeLatestSnapshotFromNewestMonth();

  console.log("[DONE]");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
