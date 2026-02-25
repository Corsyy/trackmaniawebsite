// scripts/totd-fetcher.js
// Node 18+ / 20+ (global fetch). ESM.
// Generates:
//   - ./data/totd/YYYY-MM.json
//   - ./data/totd/months.json  (derived from existing month files)
//   - ./totd.json              (latest day snapshot)
// Safe against transient API/TMX failures: it will still write the month file.

import { mkdir, writeFile, readFile, access, readdir } from "node:fs/promises";
import { constants as FS } from "node:fs";
import path from "node:path";

/* ----------------------------- config/constants ---------------------------- */
const PUBLIC_DIR = process.env.PUBLIC_DIR || ".";
const ROOT = PUBLIC_DIR.replace(/\/+$/, "") || ".";
const TOTD_DIR = path.join(ROOT, "data", "totd");
const TOTD_LATEST = path.join(ROOT, "totd.json");

const TMIO = "https://trackmania.io";
const TMX_API = "https://trackmania.exchange/api";
const TMX_DL_BASE = "https://trackmania.exchange/maps/download";
const USER_AGENT = process.env.USER_AGENT || "tm-totd-fetcher/2.0 (github-actions)";

const DEBUG = process.env.DEBUG === "1" || process.env.DEBUG === "true";
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
  try {
    return JSON.parse(await readFile(p, "utf8"));
  } catch {
    return fallback;
  }
};
const writeJson = (p, obj) => writeFile(p, JSON.stringify(obj, null, 2) + "\n", "utf8");

/* --------------------------------- utils ----------------------------------- */
const pad2 = (n) => String(n).padStart(2, "0");
const monthKey = (y, m1) => `${y}-${pad2(m1)}`;
const dateKey = (y, m1, d) => `${y}-${pad2(m1)}-${pad2(d)}`;

async function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function fetchRetry(url, opts = {}, retries = 5, baseDelay = 500) {
  let lastErr;
  for (let i = 0; i <= retries; i++) {
    try {
      const r = await fetch(url, {
        ...opts,
        headers: { "User-Agent": USER_AGENT, ...(opts.headers || {}) },
      });

      if (r.status === 429 || (r.status >= 500 && r.status <= 599)) {
        const wait = Math.min(baseDelay * 2 ** i, 8000);
        dlog("retry", i, r.status, url, "wait", wait);
        await sleep(wait);
        continue;
      }
      return r;
    } catch (e) {
      lastErr = e;
      const wait = Math.min(baseDelay * 2 ** i, 8000);
      dlog("retry", i, "err", e?.message || e, url, "wait", wait);
      await sleep(wait);
    }
  }
  throw lastErr || new Error(`fetch failed: ${url}`);
}

function stripTmFormatting(input) {
  if (!input || typeof input !== "string") return input;
  const D = "\uFFF0";
  let s = input.replace(/\$\$/g, D);
  s = s.replace(/\$[0-9a-fA-F]{1,3}|\$[a-zA-Z]|\$[<>\[\]\(\)]/g, "");
  return s.replace(new RegExp(D, "g"), "$");
}

function normalizeDaysPayload(j) {
  if (Array.isArray(j)) return j;
  if (!j || typeof j !== "object") return [];
  if (Array.isArray(j.days)) return j.days;
  if (Array.isArray(j.totd)) return j.totd;
  if (Array.isArray(j.tracks)) return j.tracks;
  if (Array.isArray(j.results)) return j.results;
  if (j.month && Array.isArray(j.month.days)) return j.month.days;
  return [];
}

// tm.io has changed field naming over time; accept multiple variants
function tmioDayNumber(dayObj, idx) {
  return (
    dayObj?.day ??
    dayObj?.dayIndex ??
    dayObj?.monthday ??
    dayObj?.monthDay ??
    dayObj?.dayInMonth ??
    dayObj?.monthDayIndex ??
    (idx + 1)
  );
}

function extractIsoLikeDate(obj) {
  if (!obj || typeof obj !== "object") return null;

  const candidates = [
    obj.timestamp,
    obj.date,
    obj.datetime,
    obj.dayTimestamp,
    obj?.map?.timestamp,
    obj?.map?.date,
    obj?.map?.datetime,
  ];

  for (const v of candidates) {
    if (typeof v === "string") {
      const d = new Date(v);
      if (!Number.isNaN(d.getTime())) return d;
    } else if (typeof v === "number" && Number.isFinite(v)) {
      const ms = v > 1e12 ? v : v * 1000;
      const d = new Date(ms);
      if (!Number.isNaN(d.getTime())) return d;
    }
  }
  return null;
}

function inferMonthFromDays(remoteDays) {
  const tally = new Map(); // "YYYY-MM" -> count

  for (const d of remoteDays || []) {
    const dt = extractIsoLikeDate(d) || extractIsoLikeDate(d?.map);
    if (!dt) continue;
    const y = dt.getUTCFullYear();
    const m1 = dt.getUTCMonth() + 1;
    const key = `${y}-${pad2(m1)}`;
    tally.set(key, (tally.get(key) || 0) + 1);
  }

  let best = null;
  let bestCount = 0;
  for (const [k, c] of tally.entries()) {
    if (c > bestCount) {
      best = k;
      bestCount = c;
    }
  }
  return best; // or null
}

function tmioMonthYear(resp, daysArr) {
  // 1) Most robust: infer from day timestamps
  const inferred = inferMonthFromDays(daysArr);
  if (inferred) {
    const [y, mm] = inferred.split("-");
    return { y: Number(y), m1: Number(mm) };
  }

  // 2) Fallback to resp.month, handle 0-based vs 1-based
  if (resp && typeof resp === "object" && resp.month && typeof resp.month === "object") {
    const y = Number(resp.month.year);
    const raw = Number(resp.month.month);
    if (Number.isFinite(y) && Number.isFinite(raw)) {
      const m1 = raw >= 0 && raw <= 11 ? raw + 1 : raw;
      if (m1 >= 1 && m1 <= 12) return { y, m1 };
    }
  }

  // 3) Last resort: current UTC month
  const now = new Date();
  return { y: now.getUTCFullYear(), m1: now.getUTCMonth() + 1 };
}

/* ------------------------------ tm.io helpers ------------------------------ */
async function fetchTmioMonth(index = 0) {
  const r = await fetchRetry(`${TMIO}/api/totd/${index}`);
  if (!r.ok) throw new Error(`tm.io totd[${index}] failed: ${r.status}`);
  return r.json();
}

/* ------------------------------ TMX helpers -------------------------------- */
async function fetchTmxInfoByUid(uid) {
  if (!uid) return null;
  const url = `${TMX_API}/maps/get_map_info/uid/${encodeURIComponent(uid)}`;
  const r = await fetchRetry(url);
  if (!r.ok) return null;
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
  const toNum = (v) => (v == null ? null : Number(v));
  return {
    authorTime: toNum(tmx?.AuthorTime),
    goldTime: toNum(tmx?.GoldTime),
    silverTime: toNum(tmx?.SilverTime),
    bronzeTime: toNum(tmx?.BronzeTime),
    difficulty: toNum(tmx?.Difficulty),
  };
}

async function fetchMapDetails(mapUid) {
  if (!mapUid) return { downloadUrl: null, medals: null };

  // 1) Prefer TMX for medals/difficulty + a stable download link
  try {
    const tmx = await fetchTmxInfoByUid(mapUid);
    if (tmx && tmx.TrackID) {
      let shortName = tmx.ShortName || tmx.shortName || null;

      // sometimes unlisted maps need a second fetch by TrackID for ShortName
      if ((tmx.Unlisted === true || tmx.Unlisted === 1) && !shortName) {
        const byId = await fetchTmxInfoById(tmx.TrackID);
        shortName = byId?.ShortName || byId?.shortName || null;
      }

      const downloadable = tmx.Downloadable ?? true;
      const downloadUrl = downloadable ? tmxDownloadUrl(tmx.TrackID, shortName) : null;
      const medals = pickMedalFields(tmx);
      return { downloadUrl, medals };
    }
  } catch (e) {
    dlog("TMX resolver error", mapUid, e?.message || e);
  }

  // 2) Fallback: tm.io map endpoint (download only; no medals)
  try {
    const r = await fetchRetry(`${TMIO}/api/map/${encodeURIComponent(mapUid)}`);
    if (!r.ok) return { downloadUrl: null, medals: null };
    const j = await r.json();
    return { downloadUrl: j?.file || j?.download || j?.fileUrl || null, medals: null };
  } catch (e) {
    dlog("tm.io map resolver error", mapUid, e?.message || e);
    return { downloadUrl: null, medals: null };
  }
}

/* ------------------------------ month writing ------------------------------ */
async function rebuildMonthIndex(dir) {
  await ensureDir(dir);
  const items = await readdir(dir, { withFileTypes: true });
  const months = items
    .filter((e) => e.isFile() && /^\d{4}-\d{2}\.json$/.test(e.name))
    .map((e) => e.name.replace(/\.json$/, ""))
    .sort()
    .reverse();

  await writeJson(path.join(dir, "months.json"), { months });
  return months;
}

function baseDayRecord(y, m1, entry, idx) {
  const m = entry?.map || entry;
  const uid = m?.mapUid ?? entry?.mapUid ?? null;

  let name = m?.name ?? m?.mapName ?? entry?.name ?? "(unknown map)";
  let authorDisplayName =
    m?.authorPlayer?.name ??
    m?.authorplayer?.name ??
    m?.authorName ??
    m?.author ??
    entry?.authorPlayer?.name ??
    entry?.authorplayer?.name ??
    entry?.authorName ??
    entry?.author ??
    "(unknown)";

  const thumb =
    m?.thumbnail ??
    m?.thumbnailUrl ??
    m?.thumbnailURL ??
    entry?.thumbnail ??
    entry?.thumbnailUrl ??
    entry?.thumbnailURL ??
    "";

  const authorAccountId =
    m?.authorPlayer?.accountId ??
    m?.authorplayer?.accountid ??
    m?.authorplayer?.id ??
    entry?.authorPlayer?.accountId ??
    entry?.authorplayer?.accountid ??
    entry?.authorplayer?.id ??
    null;

  const d = tmioDayNumber(entry, idx);

  name = stripTmFormatting(name);
  authorDisplayName = stripTmFormatting(authorDisplayName);

  return {
    date: dateKey(y, m1, d),
    map: {
      uid,
      name,
      authorAccountId,
      authorDisplayName,
      thumbnailUrl: thumb,
      downloadUrl: null,

      authorTime: null,
      goldTime: null,
      silverTime: null,
      bronzeTime: null,
      difficulty: null,
    },
  };
}

async function writeTotdMonth(index = 0) {
  const resp = await fetchTmioMonth(index);
  const remoteDays = normalizeDaysPayload(resp);
  const { y, m1 } = tmioMonthYear(resp, remoteDays);
  const mKey = monthKey(y, m1);

  dlog("write month index", index, "->", mKey, "days:", remoteDays?.length || 0);

  // If tm.io returned nothing, don't create a bogus month file.
  if (!Array.isArray(remoteDays) || remoteDays.length === 0) {
    dlog("No days returned for", mKey, "- skipping write.");
    return { ym: mKey, wrote: false };
  }

  const monthPath = path.join(TOTD_DIR, `${mKey}.json`);

  // Load prior month file so manual downloadUrl (or previous data) persists.
  const prev = await loadJson(monthPath, { month: mKey, days: {} });
  const prevDays = prev?.days || {};

  const daysArr = remoteDays.map((entry, i) => baseDayRecord(y, m1, entry, i));

  // Hydrate per day with TMX medals/difficulty + download, but NEVER abort the whole month on one failure.
  for (const rec of daysArr) {
    const prevRec = prevDays[rec.date]?.map || {};

    // Preserve any existing/manual downloadUrl
    if (prevRec.downloadUrl) rec.map.downloadUrl = prevRec.downloadUrl;

    // Carry forward medals if already present
    rec.map.authorTime = prevRec.authorTime ?? rec.map.authorTime;
    rec.map.goldTime = prevRec.goldTime ?? rec.map.goldTime;
    rec.map.silverTime = prevRec.silverTime ?? rec.map.silverTime;
    rec.map.bronzeTime = prevRec.bronzeTime ?? rec.map.bronzeTime;
    rec.map.difficulty = prevRec.difficulty ?? rec.map.difficulty;

    // Only fetch if we need something
    const needsDetails =
      !!rec.map.uid && (!rec.map.downloadUrl || prevRec.authorTime == null);

    if (needsDetails) {
      try {
        const { downloadUrl, medals } = await fetchMapDetails(rec.map.uid);

        if (!rec.map.downloadUrl) rec.map.downloadUrl = downloadUrl || null;

        if (medals) {
          rec.map.authorTime = medals.authorTime;
          rec.map.goldTime = medals.goldTime;
          rec.map.silverTime = medals.silverTime;
          rec.map.bronzeTime = medals.bronzeTime;
          rec.map.difficulty = medals.difficulty;
        }
      } catch (e) {
        dlog("fetchMapDetails failed", rec.map.uid, e?.message || e);
      }

      // Be nice to public endpoints
      await sleep(120);
    }
  }

  const daysOut = {};
  for (const rec of daysArr) daysOut[rec.date] = rec;

  await ensureDir(TOTD_DIR);
  await writeJson(monthPath, { month: mKey, days: daysOut });

  // Rebuild months.json from actual files (prevents lying index)
  await rebuildMonthIndex(TOTD_DIR);

  // Latest snapshot
  const keys = Object.keys(daysOut).sort();
  const latestKey = keys[keys.length - 1] || null;
  if (latestKey) {
    const latest = daysOut[latestKey];
    await writeJson(TOTD_LATEST, { generatedAt: new Date().toISOString(), ...latest });
  }

  return { ym: mKey, wrote: true };
}

/* ----------------------------------- main ---------------------------------- */
async function main() {
  await ensureDir(TOTD_DIR);

  const now = new Date();
  const currentYm = `${now.getUTCFullYear()}-${pad2(now.getUTCMonth() + 1)}`;

  // Try a few indices: sometimes index 0 can briefly show previous month
  // We pick the first payload that resolves to current UTC month.
  let did = false;

  for (let idx = 0; idx <= 3; idx++) {
    try {
      const resp = await fetchTmioMonth(idx);
      const remoteDays = normalizeDaysPayload(resp);
      const { y, m1 } = tmioMonthYear(resp, remoteDays);
      const ym = monthKey(y, m1);

      dlog("candidate", idx, "->", ym, "days:", remoteDays?.length || 0);

      if (ym === currentYm) {
        const r = await writeTotdMonth(idx);
        did = r.wrote;
        break;
      }
    } catch (e) {
      dlog("candidate failed", idx, e?.message || e);
    }
  }

  // Fallback: still write index 0 (better than nothing)
  if (!did) {
    await writeTotdMonth(0);
  }

  console.log("[DONE] TOTD updated.");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
