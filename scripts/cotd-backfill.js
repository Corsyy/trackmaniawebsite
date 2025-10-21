import { mkdir, writeFile, readFile, access, readdir } from "node:fs/promises";
import { constants as FS } from "node:fs";
import path from "node:path";

// ---------- config ----------
const PUBLIC_DIR  = process.env.PUBLIC_DIR || ".";
const COTD_DIR    = `${PUBLIC_DIR.replace(/\/+$/,"")}/data/cotd`;

const MEET  = "https://meet.trackmania.nadeo.club";
const CORE  = "https://prod.trackmania.core.nadeo.online";

const NADEO_REFRESH_TOKEN = process.env.NADEO_REFRESH_TOKEN || "";
const WATCH_INTERVAL_MS   = parseInt(process.env.UPDATE_EVERY || "", 10) || 15 * 60 * 1000;

// ---------- fs helpers ----------
const ensureDir = (p) => mkdir(p, { recursive: true });
const exists    = async (p) => { try { await access(p, FS.F_OK); return true; } catch { return false; } };
const loadJson  = async (p, f) => (await exists(p)) ? JSON.parse(await readFile(p, "utf8")) : f;
const writeJson = (p, obj) => writeFile(p, JSON.stringify(obj, null, 2), "utf8");

// ---------- date helpers ----------
const pad2 = (n) => String(n).padStart(2, "0");
const monthKey = (y, m1) => `${y}-${pad2(m1)}`;
const dateKey  = (y, m1, d) => `${y}-${pad2(m1)}-${pad2(d)}`;
function* daysOfMonth(year, month1) {
  const days = new Date(Date.UTC(year, month1, 0)).getUTCDate();
  for (let d = 1; d <= days; d++) yield d;
}
function ymdFromDate(date) {
  return {
    y: date.getUTCFullYear(),
    m1: date.getUTCMonth() + 1,
    d: date.getUTCDate(),
  };
}
function firstUTCOfMonth(y, m1) {
  return new Date(Date.UTC(y, m1 - 1, 1, 0, 0, 0));
}
function clampToToday(y, m1, d) {
  const now = new Date();
  const nowY = now.getUTCFullYear();
  const nowM1 = now.getUTCMonth() + 1;
  const nowD = now.getUTCDate();
  if (y > nowY) return false;
  if (y === nowY && m1 > nowM1) return false;
  if (y === nowY && m1 === nowM1 && d > nowD) return false;
  return true;
}

// ---------- robust fetch with retries ----------
async function sleep(ms){ return new Promise(r => setTimeout(r, ms)); }

async function fetchRetry(url, opts={}, retries=5, baseDelay=500) {
  let lastErr;
  for (let i=0;i<=retries;i++){
    try {
      const r = await fetch(url, opts);
      if (r.status === 429 || (r.status >= 500 && r.status <= 599)) {
        const wait = Math.min(baseDelay * Math.pow(2,i), 8000);
        await sleep(wait);
        continue;
      }
      return r;
    } catch (e) {
      lastErr = e;
      const wait = Math.min(baseDelay * Math.pow(2,i), 8000);
      await sleep(wait);
    }
  }
  throw lastErr || new Error(`fetch failed for ${url}`);
}

// ---------- auth ----------
if (!NADEO_REFRESH_TOKEN) {
  console.error("ERROR: Missing NADEO_REFRESH_TOKEN env.");
  process.exit(1);
}
let _cachedAccess = { token: null, expAt: 0 };

async function nadeoAccess() {
  const now = Date.now();
  if (_cachedAccess.token && now < _cachedAccess.expAt - 10_000) {
    return _cachedAccess.token;
  }
  const r = await fetchRetry(`${CORE}/v2/authentication/token/refresh`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `nadeo_v1 t=${NADEO_REFRESH_TOKEN}` },
    body: JSON.stringify({ audience: "NadeoLiveServices" })
  });
  if (!r.ok) throw new Error(`refresh failed: ${r.status}`);
  const j = await r.json();
  const token = j.accessToken;
  // Heuristic: default 9 minutes if no expiresIn given
  const expMs = (j.expiresIn ? j.expiresIn * 1000 : 9 * 60 * 1000);
  _cachedAccess = { token, expAt: Date.now() + expMs };
  return token;
}
const nadeoHeaders = async (extra={}) => ({
  Authorization: `nadeo_v1 t=${await nadeoAccess()}`,
  ...extra,
});

// ---------- helpers: competitions ----------
function looksLikeCotd(c) {
  const name = String(c?.name || "").toLowerCase();
  return name.includes("cup of the day") || name.includes("cotd");
}

async function listCompetitions(offset = 0, length = 100) {
  const r = await fetchRetry(`${MEET}/api/competitions?offset=${offset}&length=${length}`, {
    headers: await nadeoHeaders()
  });
  if (!r.ok) throw new Error(`competitions list failed: ${r.status}`);
  return r.json(); // { competitions, total, ... } (shape may vary)
}

/**
 * Find the COTD competition by date. Scans pages, preferring a strict YYYY-MM-DD
 * match in the name. Falls back to loose partials.
 */
async function findCotdCompetitionByDate(y, m1, d) {
  const wanted = `${y}-${pad2(m1)}-${pad2(d)}`;
  const MAX_PAGES = 60;
  const PAGE_LEN  = 100;

  for (let page = 0; page < MAX_PAGES; page++) {
    const offset = page * PAGE_LEN;
    const data = await listCompetitions(offset, PAGE_LEN);
    const comps = data?.competitions || data?.items || [];

    if (!Array.isArray(comps) || comps.length === 0) break;

    // strict
    let match = comps.find(c => looksLikeCotd(c) && String(c.name).includes(wanted));

    // loose fallback
    if (!match) {
      const dayStr = ` ${d} `;
      match = comps.find(c => looksLikeCotd(c) && String(c.name).toLowerCase().includes(`cotd`) && String(c.name).includes(dayStr));
    }

    if (!match) {
      // try by start date if provided (some envs expose 'startDate'/'beginDate')
      const alt = comps.find(c => {
        const dt = c.startDate || c.beginDate || c.startTime;
        if (!dt) return false;
        try {
          const cd = new Date(dt);
          const cy = cd.getUTCFullYear();
          const cm1 = cd.getUTCMonth() + 1;
          const cdn = cd.getUTCDate();
          return looksLikeCotd(c) && cy === y && cm1 === m1 && cdn === d;
        } catch { return false; }
      });
      if (alt) match = alt;
    }

    if (match) return match;

    const total = data?.total ?? (offset + comps.length);
    if (offset + comps.length >= total) break;
  }

  return null;
}

// ---------- helpers: winners ----------
async function getD1WinnerForCompetition(compId) {
  if (!compId) return null;

  const roundsRes = await fetchRetry(`${MEET}/api/competitions/${compId}/rounds`, { headers: await nadeoHeaders() });
  if (!roundsRes.ok) throw new Error(`rounds failed: ${roundsRes.status}`);
  const rounds = await roundsRes.json();
  if (!Array.isArray(rounds) || !rounds.length) return null;

  const finalRound =
    rounds.find(r => String(r?.name ?? "").toLowerCase().includes("final")) ??
    rounds.reduce((a, b) => ((a?.position ?? 0) > (b?.position ?? 0) ? a : b));

  if (!finalRound?.id) return null;

  const matchesRes = await fetchRetry(`${MEET}/api/rounds/${finalRound.id}/matches?length=50&offset=0`, { headers: await nadeoHeaders() });
  if (!matchesRes.ok) throw new Error(`matches failed: ${matchesRes.status}`);
  const matches = await matchesRes.json();
  const match = matches?.matches?.[0] || matches?.[0];
  if (!match?.id) return null;

  const resultsRes = await fetchRetry(`${MEET}/api/matches/${match.id}/results?length=512&offset=0`, { headers: await nadeoHeaders() });
  if (!resultsRes.ok) throw new Error(`results failed: ${resultsRes.status}`);
  const results = await resultsRes.json();

  const arr = results?.results || results || [];
  if (!Array.isArray(arr) || arr.length === 0) return null;

  arr.sort((a, b) => {
    const ar = a.rank ?? a.position ?? Infinity;
    const br = b.rank ?? b.position ?? Infinity;
    if (ar !== br) return ar - br;
    const ap = (typeof a.points === "number" ? -a.points : 0);
    const bp = (typeof b.points === "number" ? -b.points : 0);
    return ap - bp;
  });

  return arr[0]?.participant ?? null;
}

// ---------- display name hydration (bulk+cache) ----------
const NAMES_CACHE_PATH = path.join(COTD_DIR, "_names-cache.json");

async function loadNamesCache() {
  return await loadJson(NAMES_CACHE_PATH, {});
}
async function saveNamesCache(cache) {
  await ensureDir(COTD_DIR);
  await writeJson(NAMES_CACHE_PATH, cache);
}

/** Core: /accounts/displayNames?accountIdList=...  (bulk) */
async function fetchDisplayNamesBulk(accountIds) {
  if (!accountIds.length) return {};
  const ids = [...new Set(accountIds)].filter(Boolean);
  if (!ids.length) return {};

  // API tends to allow ~100 per call safely
  const chunks = [];
  for (let i=0;i<ids.length;i+=100) chunks.push(ids.slice(i, i+100));

  const out = {};
  for (const chunk of chunks) {
    const url = new URL(`${CORE}/accounts/displayNames`);
    url.searchParams.set("accountIdList", chunk.join(","));
    const r = await fetchRetry(url.toString(), { headers: await nadeoHeaders() });
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
  // return a map for convenience
  const map = {};
  for (const id of ids) map[id] = cache[id] ?? null;
  return map;
}

// ---------- write month & index ----------
async function upsertMonth(dir, key, dayKey, record) {
  await ensureDir(dir);
  const p = path.join(dir, `${key}.json`);
  const data = await loadJson(p, { month: key, days: {} });
  data.days[dayKey] = record;
  await writeJson(p, data);

  // rebuild months.json
  const items = await readdir(dir, { withFileTypes: true });
  const months = items
    .filter(e => e.isFile() && e.name.endsWith(".json") && e.name !== "months.json" && !e.name.startsWith("_"))
    .map(e => e.name.replace(/\.json$/,""))
    .sort()
    .reverse();
  await writeJson(path.join(dir, "months.json"), { months });
}

// ---------- month backfill/update ----------
async function updateMonth(year, month1) {
  const mKey = monthKey(year, month1);
  const monthPath = path.join(COTD_DIR, `${mKey}.json`);
  const monthData = await loadJson(monthPath, { month: mKey, days: {} });

  console.log(`[COTD] Updating month ${mKey} …`);

  // Collect changes & unresolved names
  const winnersToHydrate = new Set();

  for (const d of daysOfMonth(year, month1)) {
    if (!clampToToday(year, month1, d)) break; // don't look into future days

    const dk = dateKey(year, month1, d);
    if (!monthData.days[dk]) monthData.days[dk] = { date: dk, cotd: null };

    // If already has a winner, keep—but still hydrate name if missing
    if (monthData.days[dk]?.cotd?.winnerAccountId && !monthData.days[dk]?.cotd?.winnerDisplayName) {
      winnersToHydrate.add(monthData.days[dk].cotd.winnerAccountId);
      continue;
    }

    // Otherwise (no winner yet), try to find competition & winner now
    try {
      const comp = await findCotdCompetitionByDate(year, month1, d);
      if (!comp) {
        // leave as is; maybe not published yet or naming drift
        continue;
      }
      const cid = comp.id || comp.liveId || comp.uid;
      const winnerId = await getD1WinnerForCompetition(cid);
      if (!winnerId) continue;

      monthData.days[dk] = {
        date: dk,
        cotd: { winnerAccountId: winnerId, winnerDisplayName: null }
      };
      winnersToHydrate.add(winnerId);
      console.log(`  ${dk}  competition=${cid}  winner=${winnerId}`);
    } catch (e) {
      console.log(`  ${dk}  error: ${e.message}`);
    }
  }

  // Bulk-hydrate names for any IDs missing display names
  if (winnersToHydrate.size) {
    const nameMap = await hydrateDisplayNames([...winnersToHydrate]);
    for (const dk of Object.keys(monthData.days)) {
      const c = monthData.days[dk]?.cotd;
      if (c?.winnerAccountId && !c.winnerDisplayName) {
        c.winnerDisplayName = nameMap[c.winnerAccountId] ?? null;
      }
    }
  }

  // Write updated month and months index
  await ensureDir(COTD_DIR);
  await writeJson(monthPath, monthData);

  const items = await readdir(COTD_DIR, { withFileTypes: true });
  const months = items
    .filter(e => e.isFile() && e.name.endsWith(".json") && e.name !== "months.json" && !e.name.startsWith("_"))
    .map(e => e.name.replace(/\.json$/,""))
    .sort()
    .reverse();
  await writeJson(path.join(COTD_DIR, "months.json"), { months });

  console.log(`[COTD] ${mKey} done.`);
}

// ---------- top-level routines ----------
async function updatePrevAndCurrent() {
  const now = new Date();
  const { y, m1 } = ymdFromDate(now);
  const prev = new Date(Date.UTC(y, m1 - 2, 1));

  await updateMonth(prev.getUTCFullYear(), prev.getUTCMonth() + 1);
  await updateMonth(y, m1);
}

async function updateSpecific(year, month1) {
  await updateMonth(year, month1);
}

// ---------- CLI ----------
async function main() {
  await ensureDir(COTD_DIR);

  const args = process.argv.slice(2).map(x => x.trim().toLowerCase());

  if (args.length === 2 && /^\d{4}$/.test(args[0]) && /^\d{1,2}$/.test(args[1])) {
    const year = parseInt(args[0], 10);
    const month1 = parseInt(args[1], 10);
    if (!year || !month1) throw new Error("Usage: node scripts/cotd-backfill.js YYYY MM");
    await updateSpecific(year, month1);
    return;
  }

  if (args.includes("--watch")) {
    console.log(`[COTD] Watch mode on. Interval: ${WATCH_INTERVAL_MS}ms`);
    // initial run
    await updatePrevAndCurrent();

    // periodic updates
    // covers: late-publishing winners, name hydration, and today's result once it's available
    // Also re-checks yesterday in case results arrived late.
    setInterval(async () => {
      try {
        await updatePrevAndCurrent();
      } catch (e) {
        console.error("[COTD] periodic update error:", e);
      }
    }, WATCH_INTERVAL_MS);
    return; // keep process alive
  }

  // default one-off update for prev+current month
  await updatePrevAndCurrent();
}

main().catch(e => { console.error(e); process.exit(1); });
