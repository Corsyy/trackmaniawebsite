// scripts/cotd-fetcher.js
// Node 20+ (native fetch)
import { mkdir, writeFile, readFile, access, readdir } from "node:fs/promises";
import { constants as FS } from "node:fs";
import path from "node:path";

/* ------------------- constants ------------------- */
const PUBLIC_DIR  = process.env.PUBLIC_DIR || ".";
const COTD_DIR    = `${PUBLIC_DIR.replace(/\/+$/,"")}/data/cotd`;
const TOTD_DIR    = `${PUBLIC_DIR.replace(/\/+$/,"")}/data/totd`;
const COTD_LATEST = `${PUBLIC_DIR.replace(/\/+$/,"")}/cotd.json`;
const TOTD_LATEST = `${PUBLIC_DIR.replace(/\/+$/,"")}/totd.json`;

const LIVE  = "https://live-services.trackmania.nadeo.live"; // not used directly here
const MEET  = "https://meet.trackmania.nadeo.club";
const CORE  = "https://prod.trackmania.core.nadeo.online";
const TMIO  = "https://trackmania.io";

const NADEO_REFRESH_TOKEN = process.env.NADEO_REFRESH_TOKEN || "";
const DEBUG = process.env.DEBUG === "1";
const dlog = (...a) => { if (DEBUG) console.log("[FETCHER]", ...a); };

/* ------------------- fs helpers ------------------- */
const ensureDir = (p) => mkdir(p, { recursive: true });
const exists    = async (p) => { try { await access(p, FS.F_OK); return true; } catch { return false; } };
const loadJson  = async (p, f) => (await exists(p)) ? JSON.parse(await readFile(p, "utf8")) : f;
const writeJson = (p, obj) => writeFile(p, JSON.stringify(obj, null, 2), "utf8");

/* ------------------- dates ------------------- */
const pad2     = (n) => String(n).padStart(2, "0");
const monthKey = (y, m1) => `${y}-${pad2(m1)}`;
const dateKey  = (y, m1, d) => `${y}-${pad2(m1)}-${pad2(d)}`;
function* daysOfMonth(year, month1) {
  const days = new Date(Date.UTC(year, month1, 0)).getUTCDate();
  for (let d = 1; d <= days; d++) yield d;
}
function clampToToday(y, m1, d) {
  const now = new Date();
  const ny = now.getUTCFullYear(), nm1 = now.getUTCMonth()+1, nd = now.getUTCDate();
  if (y > ny) return false;
  if (y === ny && m1 > nm1) return false;
  if (y === ny && m1 === nm1 && d > nd) return false;
  return true;
}

/* ------------------- fetch w/ retry (for tm.io) ------------------- */
async function sleep(ms){ return new Promise(r => setTimeout(r, ms)); }
async function fetchRetry(url, opts={}, retries=5, baseDelay=500) {
  let lastErr;
  for (let i=0; i<=retries; i++) {
    try {
      const r = await fetch(url, opts);
      if (r.status === 429 || (r.status >= 500 && r.status <= 599)) {
        const wait = Math.min(baseDelay * Math.pow(2, i), 8000);
        await sleep(wait);
        continue;
      }
      return r;
    } catch (e) {
      lastErr = e;
      const wait = Math.min(baseDelay * Math.pow(2, i), 8000);
      await sleep(wait);
    }
  }
  throw lastErr || new Error(`fetch failed for ${url}`);
}

/* ------------------- AUTH (multi-audience for Meet/Core) ------------------- */
if (!NADEO_REFRESH_TOKEN) {
  console.error("ERROR: Missing NADEO_REFRESH_TOKEN env.");
  process.exit(1);
}

const tokenCache = new Map(); // audience -> {token, expAt}

async function refreshForAudience(audience) {
  const r = await fetch(`${CORE}/v2/authentication/token/refresh`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `nadeo_v1 t=${NADEO_REFRESH_TOKEN}`
    },
    body: JSON.stringify({ audience })
  });
  if (!r.ok) {
    const txt = await r.text().catch(() => "");
    throw new Error(`refresh(${audience}) failed: ${r.status} ${txt}`);
  }
  const j = await r.json();
  const token = j.accessToken;
  const expMs = (j.expiresIn ? j.expiresIn * 1000 : 9 * 60 * 1000);
  tokenCache.set(audience, { token, expAt: Date.now() + expMs });
  return token;
}

async function getToken(audience) {
  const entry = tokenCache.get(audience);
  if (entry && Date.now() < entry.expAt - 10_000) return entry.token;
  return refreshForAudience(audience);
}

async function authedFetch(url, { audience, init = {}, retryOnAuth = true } = {}) {
  let token = await getToken(audience);
  let r = await fetch(url, { ...init, headers: { ...(init.headers || {}), Authorization: `nadeo_v1 t=${token}` } });
  if (retryOnAuth && (r.status === 401 || r.status === 403)) {
    token = await refreshForAudience(audience);
    r = await fetch(url, { ...init, headers: { ...(init.headers || {}), Authorization: `nadeo_v1 t=${token}` } });
  }
  return r;
}

const fetchMeet = (url, init = {}) => authedFetch(url, { audience: "NadeoClubServices", init });
const fetchCore = (url, init = {}) => authedFetch(url, { audience: "NadeoLiveServices", init });

/* ------------------- indexes ------------------- */
async function rebuildMonthIndex(dir) {
  await ensureDir(dir);
  const items = await readdir(dir, { withFileTypes: true });
  const months = items
    .filter(e => e.isFile() && e.name.endsWith(".json") && e.name !== "months.json" && !e.name.startsWith("_"))
    .map(e => e.name.replace(/\.json$/, ""))
    .sort()
    .reverse();
  await writeJson(path.join(dir, "months.json"), { months });
}

/* ------------------- TOTD (trackmania.io) ------------------- */
// Strip Trackmania/ManiaPlanet $-formatting from names ($f00, $o, $z, $$, etc.)
function stripTmFormatting(input) {
  if (!input || typeof input !== "string") return input;
  const DOLLAR_TOKEN = "\uFFF0"; // preserve literal $$
  let s = input.replace(/\$\$/g, DOLLAR_TOKEN);
  s = s.replace(/\$[0-9a-fA-F]{1,3}|\$[a-zA-Z]|\$[<>\[\]\(\)]/g, "");
  return s.replace(new RegExp(DOLLAR_TOKEN, "g"), "$");
}

// normalize timestamps that can be ISO / seconds / milliseconds
function toMs(dt) {
  if (dt == null) return NaN;
  let n = typeof dt === "string" ? Number(dt) : dt;
  if (Number.isFinite(n)) { if (n < 2e12) n *= 1000; return n; }
  const p = Date.parse(dt); return Number.isFinite(p) ? p : NaN;
}

// extract accountId / displayName from varied result shapes
function extractWinnerFields(result) {
  const p = result?.participant ?? result?.player ?? null;
  let accountId = null, displayName = null;
  if (typeof p === "string") accountId = p;
  if (!accountId && p && typeof p === "object") {
    accountId = p.accountId || p.id || p.player?.accountId || p.player?.id || null;
    displayName = p.displayName || p.name || p.player?.displayName || p.player?.name ||
                  result?.displayName || result?.name || null;
  }
  if (!displayName) displayName = result?.playerName || result?.nickname || null;
  return { accountId: accountId || null, displayName: displayName || null };
}

async function fetchTmioMonth(index = 0) {
  const r = await fetchRetry(`${TMIO}/api/totd/${index}`, { headers: { "User-Agent": "tm-cotd" } });
  if (!r.ok) throw new Error(`tm.io totd[${index}] failed: ${r.status}`);
  return r.json();
}
function tmioMonthYear(resp) {
  const y = resp?.month?.year ?? new Date().getUTCFullYear();
  const m1 = (resp?.month?.month ?? new Date().getUTCMonth()) + 1; // tm.io 0-based
  return { y, m1 };
}
function tmioDayNumber(dayObj, idx) {
  return dayObj?.day ?? dayObj?.dayIndex ?? dayObj?.monthDay ?? dayObj?.dayInMonth ?? (idx + 1);
}
function normTmioEntry(y, m1, entry, idx) {
  const m = entry.map || entry;
  const uid   = m.mapUid ?? entry.mapUid ?? null;
  let name    = m.name ?? m.mapName ?? entry.name ?? "(unknown map)";
  let authorDisplayName =
    m.authorPlayer?.name ?? m.authorplayer?.name ?? m.authorName ?? m.author ??
    entry.authorPlayer?.name ?? entry.authorplayer?.name ?? "(unknown)";
  const thumb = m.thumbnail ?? m.thumbnailUrl ?? entry.thumbnail ?? entry.thumbnailUrl ?? "";
  const authorAccountId =
    m.authorPlayer?.accountId ?? m.authorplayer?.accountid ??
    entry.authorPlayer?.accountId ?? entry.authorplayer?.accountid ?? null;
  const d = tmioDayNumber(entry, idx);
  name = stripTmFormatting(name);
  authorDisplayName = stripTmFormatting(authorDisplayName);
  return { date: dateKey(y, m1, d), map: { uid, name, authorAccountId, authorDisplayName, thumbnailUrl: thumb } };
}
async function writeTotdMonth(index = 0) {
  const j = await fetchTmioMonth(index);
  const { y, m1 } = tmioMonthYear(j);
  const mKey = monthKey(y, m1);
  const daysOut = {};
  const daysArr = Array.isArray(j.days) ? j.days : [];
  daysArr.forEach((entry, i) => {
    const rec = normTmioEntry(y, m1, entry, i);
    daysOut[rec.date] = rec;
  });
  await ensureDir(TOTD_DIR);
  await writeJson(path.join(TOTD_DIR, `${mKey}.json`), { month: mKey, days: daysOut });
  await rebuildMonthIndex(TOTD_DIR);

  const keys = Object.keys(daysOut).sort();
  const latestKey = keys[keys.length - 1] || null;
  if (latestKey) {
    const latestTotd = daysOut[latestKey];
    await writeJson(TOTD_LATEST, { generatedAt: new Date().toISOString(), ...latestTotd });
    dlog("TOTD latest:", latestTotd.date, latestTotd.map?.name);
  } else {
    dlog("TOTD: no days found for", mKey);
  }
  return { mKey, daysOut };
}

/* ------------------- COTD helpers (Meet/Core) ------------------- */
function looksLikeCotd(c) {
  const name = String(c?.name || "").toLowerCase();
  return name.includes("cup of the day") || name.includes("cotd");
}

async function listCompetitions(offset = 0, length = 100) {
  const r = await fetchMeet(`${MEET}/api/competitions?offset=${offset}&length=${length}`);
  if (!r.ok) throw new Error(`competitions list failed: ${r.status}`);
  return r.json();
}

/** Find COTD for a given UTC date by start time within that day (±12h tolerance). */
async function findCotdCompetitionByDate(y, m1, d) {
  const dayStart = Date.UTC(y, m1 - 1, d, 0, 0, 0) - 12 * 3600 * 1000;   // widen window
  const dayEnd   = Date.UTC(y, m1 - 1, d, 23, 59, 59, 999) + 12 * 3600 * 1000;

  const MAX_PAGES = 80, PAGE_LEN = 100;
  const hits = [];

  for (let page = 0; page < MAX_PAGES; page++) {
    const offset = page * PAGE_LEN;
    const data = await listCompetitions(offset, PAGE_LEN);
    const comps = data?.competitions || data?.items || [];
    if (!Array.isArray(comps) || !comps.length) break;

    for (const c of comps) {
      const dtRaw = c.startDate ?? c.beginDate ?? c.startTime ?? c.beginTime ?? c.date ?? null;
      const ts = toMs(dtRaw);
      if (!Number.isFinite(ts)) continue;
      if (ts < dayStart || ts > dayEnd) continue;
      if (!looksLikeCotd(c)) continue;
      hits.push(c);
    }

    const total = data?.total ?? (offset + comps.length);
    if (offset + comps.length >= total) break;
  }

  if (!hits.length) return null;

  const ymd = `${y}-${String(m1).padStart(2,"0")}-${String(d).padStart(2,"0")}`;
  let pick = hits.find(c => String(c.name ?? "").includes(ymd));
  if (!pick) {
    pick = hits.reduce((best, cur) => {
      const bt = toMs(best.startDate ?? best.beginDate ?? best.startTime ?? best.beginTime);
      const ct = toMs(cur.startDate  ?? cur.beginDate  ?? cur.startTime  ?? cur.beginTime);
      return (ct < bt ? cur : best); // earliest (usually #1)
    }, hits[0]);
  }

  if (DEBUG) {
    const id = pick?.id || pick?.liveId || pick?.uid || "?";
    console.log(`[COTD] FOUND comp for ${ymd}: id=${id} name="${pick?.name}"`);
  }
  return pick;
}

async function getD1WinnerForCompetition(compId) {
  if (!compId) return null;

  const roundsRes  = await fetchMeet(`${MEET}/api/competitions/${compId}/rounds`);
  if (!roundsRes.ok) { console.log(`[COTD] rounds ${compId} -> ${roundsRes.status}`); throw new Error(`rounds failed: ${roundsRes.status}`); }
  const rounds = await roundsRes.json();
  if (!Array.isArray(rounds) || !rounds.length) return null;

  const finalRound =
    rounds.find(r => String(r?.name ?? "").toLowerCase().includes("final")) ??
    rounds.reduce((a, b) => ((a?.position ?? 0) > (b?.position ?? 0) ? a : b));
  if (!finalRound?.id) return null;

  const matchesRes = await fetchMeet(`${MEET}/api/rounds/${finalRound.id}/matches?length=200&offset=0`);
  if (!matchesRes.ok) { console.log(`[COTD] matches ${finalRound.id} -> ${matchesRes.status}`); throw new Error(`matches failed: ${matchesRes.status}`); }
  const matchesJ = await matchesRes.json();
  const matches = matchesJ?.matches || matchesJ || [];
  if (!Array.isArray(matches) || !matches.length) return null;

  let best = null; // { accountId, displayName, rank, points }

  for (const m of matches) {
    if (!m?.id) continue;
    const resultsRes = await fetchMeet(`${MEET}/api/matches/${m.id}/results?length=512&offset=0`);
    if (!resultsRes.ok) { console.log(`[COTD] results ${m.id} -> ${resultsRes.status}`); continue; }
    const results = await resultsRes.json();
    const arr = results?.results || results || [];
    if (!Array.isArray(arr) || !arr.length) continue;

    arr.sort((a, b) => {
      const ar = a.rank ?? a.position ?? Infinity;
      const br = b.rank ?? b.position ?? Infinity;
      if (ar !== br) return ar - br;
      const ap = (typeof a.points === "number" ? -a.points : 0);
      const bp = (typeof b.points === "number" ? -b.points : 0);
      return ap - bp;
    });

    const top = arr[0];
    const { accountId, displayName } = extractWinnerFields(top);
    const rank = top.rank ?? top.position ?? Infinity;
    const points = top.points ?? 0;

    if (!best || rank < best.rank || (rank === best.rank && points > best.points)) {
      best = { accountId, displayName, rank, points };
    }
    if (best.rank === 1) break; // can't beat rank 1
  }
  return best; // may have only displayName
}

/* -------- display-name hydration via Core (bulk + tiny cache) -------- */
const NAMES_CACHE_PATH = path.join(COTD_DIR, "_names-cache.json");
async function loadNamesCache() { return await loadJson(NAMES_CACHE_PATH, {}); }
async function saveNamesCache(cache) { await ensureDir(COTD_DIR); await writeJson(NAMES_CACHE_PATH, cache); }

/** Core bulk endpoint: /accounts/displayNames?accountIdList=... */
async function fetchDisplayNamesBulk(ids) {
  if (!ids?.length) return {};
  const uniq = [...new Set(ids)].filter(Boolean);
  const chunks = [];
  for (let i = 0; i < uniq.length; i += 100) chunks.push(uniq.slice(i, i+100));

  const out = {};
  for (const chunk of chunks) {
    const url = new URL(`${CORE}/accounts/displayNames`);
    url.searchParams.set("accountIdList", chunk.join(","));
    const r = await fetchCore(url.toString());
    if (!r.ok) throw new Error(`displayNames failed: ${r.status}`);
    const arr = await r.json();
    for (const it of arr || []) {
      if (it?.accountId) out[it.accountId] = it.displayName || null;
    }
  }
  return out;
}
async function hydrateDisplayNames(ids) {
  const cache = await loadNamesCache();
  const missing = ids.filter(id => cache[id] === undefined);
  if (missing.length) {
    const fetched = await fetchDisplayNamesBulk(missing);
    for (const id of missing) cache[id] = fetched[id] ?? null;
    await saveNamesCache(cache);
  }
  const map = {};
  for (const id of ids) map[id] = cache[id] ?? null;
  return map;
}

/* ------------------- month upsert ------------------- */
async function upsertMonth(dir, mKey, dayKey, record) {
  await ensureDir(dir);
  const p = path.join(dir, `${mKey}.json`);
  const data = await loadJson(p, { month: mKey, days: {} });
  data.days[dayKey] = record;
  await writeJson(p, data);
  await rebuildMonthIndex(dir);
}

/* ------------------- COTD month updater ------------------- */
async function updateCotdCurrentMonth() {
  const now = new Date();
  const y = now.getUTCFullYear();
  const m1 = now.getUTCMonth() + 1;
  const mKey = monthKey(y, m1);
  const monthPath = path.join(COTD_DIR, `${mKey}.json`);
  const monthData = await loadJson(monthPath, { month: mKey, days: {} });

  const toHydrate = new Set();

  for (const d of daysOfMonth(y, m1)) {
    if (!clampToToday(y, m1, d)) break;

    const dk = dateKey(y, m1, d);

    // always ensure the shape exists
    if (!monthData.days[dk]) {
      monthData.days[dk] = {
        date: dk,
        cotd: { winnerAccountId: null, winnerDisplayName: null }
      };
    }

    const cur = monthData.days[dk]?.cotd;
    if (cur?.winnerAccountId && !cur?.winnerDisplayName) {
      toHydrate.add(cur.winnerAccountId);
      continue;
    }

    try {
      const comp = await findCotdCompetitionByDate(y, m1, d);
      if (!comp) { console.log(`[COTD] ${dk} no competition found`); continue; }
      const cid = comp.id || comp.liveId || comp.uid;
      if (DEBUG) console.log(`[COTD] ${dk} comp id=${cid} name="${comp.name}"`);

      const winner = await getD1WinnerForCompetition(cid);
      if (!winner) {
        dlog("COTD winner not ready for", dk);
        // ensure JSON has the spot even if not ready
        monthData.days[dk] = { date: dk, cotd: { winnerAccountId: null, winnerDisplayName: null } };
        continue;
      }

      monthData.days[dk] = {
        date: dk,
        cotd: {
          winnerAccountId: winner.accountId || null,
          winnerDisplayName: winner.displayName || null
        }
      };

      if (winner.accountId) toHydrate.add(winner.accountId);
      console.log(`[COTD] ${dk} competition=${cid} winner=${winner.displayName || winner.accountId || "(unknown)"}`);
    } catch (e) {
      console.log(`[COTD] ${dk} error: ${e.message}`);
    }
  }

  // hydrate names we only had IDs for
  if (toHydrate.size) {
    const map = await hydrateDisplayNames([...toHydrate]);
    for (const dk of Object.keys(monthData.days)) {
      const c = monthData.days[dk]?.cotd;
      if (c?.winnerAccountId && !c.winnerDisplayName) {
        c.winnerDisplayName = map[c.winnerAccountId] ?? null;
      }
    }
  }

  await ensureDir(COTD_DIR);
  await writeJson(monthPath, monthData);
  await rebuildMonthIndex(COTD_DIR);

  // also write /cotd.json for "today"
  const todayKey = dateKey(y, m1, now.getUTCDate());
  const todayRec  = monthData.days[todayKey] || { date: todayKey, cotd: { winnerAccountId: null, winnerDisplayName: null } };
  await writeJson(COTD_LATEST, { generatedAt: new Date().toISOString(), ...todayRec });
}

/* ------------------- MAIN ------------------- */
async function main() {
  await ensureDir(TOTD_DIR);
  await ensureDir(COTD_DIR);

  // TOTD (current month from tm.io)
  await writeTotdMonth(0);

  // COTD (current UTC month)
  await updateCotdCurrentMonth();

  console.log("[DONE] TOTD + COTD updated.");
}
main().catch(err => { console.error(err); process.exit(1); });
