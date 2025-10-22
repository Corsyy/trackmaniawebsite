// scripts/cotd-fetcher.js
// Node 18+ (native fetch). "type": "module" in package.json or run with node --experimental-modules.

import { mkdir, writeFile, readFile, access, readdir } from "node:fs/promises";
import { constants as FS } from "node:fs";
import path from "node:path";

/* ============================== CONFIG / SECRETS ============================== */
const PUBLIC_DIR = process.env.PUBLIC_DIR || "./public";
const OUT_TOTD = path.join(PUBLIC_DIR, "totd.json");
const OUT_COTD = path.join(PUBLIC_DIR, "cotd.json");

const UA = process.env.USER_AGENT || "CorsySite/1.0";
const LIVE_REFRESH = process.env.NADEO_LIVE_REFRESH_TOKEN || "";   // nadeo_v1 t=...
const CORE_REFRESH = process.env.NADEO_CORE_REFRESH_TOKEN || "";   // nadeo_v1 t=... (optional)

if (!LIVE_REFRESH) {
  console.error("❌ Missing NADEO_LIVE_REFRESH_TOKEN");
  process.exit(1);
}

/* ================================ CONSTANTS ================================= */
const LIVE = "https://live-services.trackmania.nadeo.live";
const MEET = "https://meet.trackmania.nadeo.club";
const CORE = "https://prod.trackmania.core.nadeo.online";
const TMIO = "https://trackmania.io";

/* ================================ FS HELPERS ================================= */
async function ensureDir(dir) { await mkdir(dir, { recursive: true }); }
async function exists(p) { try { await access(p, FS.F_OK); return true; } catch { return false; } }
async function writeJson(p, obj) { await ensureDir(path.dirname(p)); await writeFile(p, JSON.stringify(obj, null, 2), "utf8"); }
async function readJson(p, fallback = null) { return (await exists(p)) ? JSON.parse(await readFile(p, "utf8")) : fallback; }

/* ============================= TOKEN MANAGEMENT ============================== */
// Cache per audience.
const cache = new Map(); // audience -> { token, expAt }

function refreshSecretFor(audience) {
  if (audience === "NadeoLiveServices") return LIVE_REFRESH;
  if (audience === "NadeoServices") return CORE_REFRESH;
  throw new Error(`Unknown audience ${audience}`);
}

async function refreshAccess(audience) {
  const refreshToken = refreshSecretFor(audience);
  if (!refreshToken) throw new Error(`Missing refresh token for ${audience} (set NADEO_CORE_REFRESH_TOKEN if you need Core).`);

  const r = await fetch(`${CORE}/v2/authentication/token/refresh`, {
    method: "POST",
    headers: { Authorization: refreshToken, "User-Agent": UA, Accept: "application/json" }
  });
  if (!r.ok) throw new Error(`refresh(${audience}) failed: ${r.status} ${await r.text()}`);
  const j = await r.json(); // { accessToken, refreshToken, expiration }
  const expAt = Date.parse(j.expiration || "") || (Date.now() + 50 * 60 * 1000);
  cache.set(audience, { token: j.accessToken /* already "nadeo_v1 t=..." */, expAt });
  return j.accessToken;
}

async function getAccess(audience) {
  const cur = cache.get(audience);
  if (cur && Date.now() < cur.expAt - 10_000) return cur.token;
  return refreshAccess(audience);
}

async function authedFetch(url, { audience, init = {}, retry = true } = {}) {
  let token = await getAccess(audience);
  let res = await fetch(url, { ...init, headers: { ...(init.headers || {}), Authorization: token, "User-Agent": UA, Accept: "application/json" } });
  if ((res.status === 401 || res.status === 403) && retry) {
    token = await refreshAccess(audience);
    res = await fetch(url, { ...init, headers: { ...(init.headers || {}), Authorization: token, "User-Agent": UA, Accept: "application/json" } });
  }
  return res;
}

const liveFetch = (pathOrUrl, init) =>
  authedFetch(pathOrUrl.startsWith("http") ? pathOrUrl : `${LIVE}${pathOrUrl}`, { audience: "NadeoLiveServices", init });
const meetFetch = (pathOrUrl, init) =>
  authedFetch(pathOrUrl.startsWith("http") ? pathOrUrl : `${MEET}${pathOrUrl}`, { audience: "NadeoLiveServices", init });
const coreFetch = (pathOrUrl, init) =>
  authedFetch(pathOrUrl.startsWith("http") ? pathOrUrl : `${CORE}${pathOrUrl}`, { audience: "NadeoServices", init });

/* ============================== TOTD (simple) ================================ */
// Low-friction: get today’s TOTD from trackmania.io (no auth needed).
async function fetchTotdLatest() {
  // Get the most recent month (requires Live access token; you already refresh this)
  const res = await liveFetch('/api/token/campaign/month?length=1');
  if (!res.ok) throw new Error(`Live month fetch failed: ${res.status} ${await res.text()}`);
  const j = await res.json();

  const month = j?.monthList?.[0];
  if (!month || !Array.isArray(month.days) || !month.days.length) {
    throw new Error('No month/days returned from Live API');
  }

  // pick the newest day that has a mapUid
  const latestDay = [...month.days]
    .sort((a, b) => (b.dayNumber ?? 0) - (a.dayNumber ?? 0))
    .find(d => d.mapUid);

  if (!latestDay) throw new Error('No TOTD day with a mapUid found');

  // Live month payload doesn’t always include map name/author; we at least return mapUid & date.
  return {
    generatedAt: new Date().toISOString(),
    date: `${month.year}-${String(month.month).padStart(2,'0')}-${String(latestDay.dayNumber).padStart(2,'0')}`,
    mapUid: latestDay.mapUid,
    name: null,          // optional: can be enriched later if you want
    author: null
  };
}

/* ============================== COTD (winner) ================================ */
const looksLikeCotd = (name = "") => {
  const n = name.toLowerCase();
  return n.includes("cup of the day") || n.includes("cotd") || /#\d{1,3}/.test(n) || n.includes("cup du jour");
};

// Find a recent Cup of the Day competition (scan a few pages).
async function findRecentCotd() {
  const PAGE = 100, PAGES = 8;
  for (let i = 0; i < PAGES; i++) {
    const r = await meetFetch(`/api/competitions?offset=${i * PAGE}&length=${PAGE}`);
    if (!r.ok) throw new Error(`competitions failed: ${r.status}`);
    const j = await r.json();
    const arr = Array.isArray(j) ? j : j?.competitions || j?.items || [];
    const hit = arr.find(c => looksLikeCotd(c.name));
    if (hit) return hit;
    if (!arr.length) break;
  }
  return null;
}

// First place on competition leaderboard = winner (usually populated soon after finish).
async function getCotdWinner(compId) {
  const r = await meetFetch(`/api/competitions/${compId}/leaderboard?length=1&offset=0`);
  if (!r.ok) throw new Error(`COTD leaderboard failed: ${r.status} ${await r.text()}`);
  const j = await r.json();
  const first = Array.isArray(j) ? j[0] : (j?.leaderboard?.[0] ?? j?.top?.[0] ?? null);
  if (!first) return null;
  return {
    accountId: first.accountId || first.player?.accountId || first.participant?.accountId || null,
    displayName: first.displayName || first.player?.displayName || first.participant?.displayName || null
  };
}

// Optional: resolve account IDs -> display names (Core). If CORE token missing, just return IDs.
async function resolveDisplayNames(ids) {
  if (!ids?.length) return {};
  if (!CORE_REFRESH) return Object.fromEntries(ids.map(id => [id, null])); // skip if no Core token

  const unique = [...new Set(ids)].filter(Boolean);
  const chunks = [];
  for (let i = 0; i < unique.length; i += 100) chunks.push(unique.slice(i, i + 100));

  const out = {};
  for (const chunk of chunks) {
    const url = `${CORE}/accounts/displayNames/?accountIdList=${chunk.join(",")}`;
    const r = await coreFetch(url);
    if (!r.ok) throw new Error(`displayNames failed: ${r.status} ${await r.text()}`);
    const j = await r.json();
    for (const row of j || []) if (row?.accountId) out[row.accountId] = row.displayName || null;
  }
  return out;
}

/* ================================== RUNNER ================================== */
async function main() {
  await ensureDir(PUBLIC_DIR);

  // TOTD
  const totd = await fetchTotdLatest();
  await writeJson(OUT_TOTD, totd);
  console.log(`✅ TOTD: ${totd.name || "(unknown)"} (${totd.mapUid || "-"})`);

  // COTD
  const comp = await findRecentCotd();
  if (!comp) throw new Error("No recent Cup of the Day competition found.");
  const winner = await getCotdWinner(comp.id || comp.liveId || comp.uid);
  if (!winner) {
    await writeJson(OUT_COTD, { generatedAt: new Date().toISOString(), competition: comp.name, winnerDisplayName: null, winnerAccountId: null, note: "winner not available yet" });
    console.log(`⏳ COTD: ${comp.name} — winner not available yet (will fill next run)`);
    return;
  }

  // hydrate display name if missing (Core)
  let displayName = winner.displayName;
  if (!displayName && winner.accountId) {
    const map = await resolveDisplayNames([winner.accountId]);
    displayName = map[winner.accountId] || null;
  }

  const out = {
    generatedAt: new Date().toISOString(),
    competition: comp.name,
    winnerDisplayName: displayName ?? null,
    winnerAccountId: winner.accountId ?? null
  };
  await writeJson(OUT_COTD, out);
  console.log(`🏆 COTD: ${comp.name} → ${displayName || winner.accountId || "(unknown)"}`);
}

main().catch(err => {
  console.error("❌ Error:", err.message);
  process.exit(1);
});
