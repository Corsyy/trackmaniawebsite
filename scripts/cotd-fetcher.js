// Node 20+ (native fetch)
import { mkdir, writeFile, readFile, access, readdir } from "node:fs/promises";
import { constants as FS } from "node:fs";
import path from "node:path";

const LIVE  = "https://live-services.trackmania.nadeo.live";
const MEET  = "https://meet.trackmania.nadeo.club";
const CORE  = "https://prod.trackmania.core.nadeo.online";
const OAUTH = "https://api.trackmania.com";

/* ------------------- where to write files ------------------- */
const PUBLIC_DIR  = process.env.PUBLIC_DIR || ".";          // <- set by workflow
const COTD_DIR    = `${PUBLIC_DIR}/data/cotd`;
const TOTD_DIR    = `${PUBLIC_DIR}/data/totd`;
const COTD_LATEST = `${PUBLIC_DIR}/cotd.json`;
const TOTD_LATEST = `${PUBLIC_DIR}/totd.json`;

/* ------------------- secrets ------------------- */
const NADEO_REFRESH_TOKEN = process.env.NADEO_REFRESH_TOKEN || "";
const TM_CLIENT_ID        = process.env.TM_CLIENT_ID || "";
const TM_CLIENT_SECRET    = process.env.TM_CLIENT_SECRET || "";

/* ------------------- tiny fs helpers ------------------- */
const ensureDir = (p) => mkdir(p, { recursive: true });
const exists = async (p) => { try { await access(p, FS.F_OK); return true; } catch { return false; } };
const loadJson = async (p, f) => (await exists(p)) ? JSON.parse(await readFile(p, "utf8")) : f;
const writeJson = (p, obj) => writeFile(p, JSON.stringify(obj, null, 2), "utf8");

/* ------------------- date helpers ------------------- */
// Trackmania.io uses 0-based month; normalize to 1-based.
function tmioMonthYear(resp) {
  const year = resp?.month?.year ?? new Date().getUTCFullYear();
  const month1 = (resp?.month?.month ?? new Date().getUTCMonth()) + 1; // +1 is important
  return { year, month1 };
}
function tmioDayNumber(dayObj, idx) {
  // Use explicit fields if present; otherwise fall back to the array index (1-based).
  return (
    dayObj?.day ??
    dayObj?.dayIndex ??
    dayObj?.monthDay ??
    dayObj?.dayInMonth ??
    (typeof idx === "number" ? idx + 1 : 1)
  );
}
const dateKey = (y, m1, d) =>
  `${y}-${String(m1).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
const monthKey = (y, m1) => `${y}-${String(m1).padStart(2, "0")}`;

/* ------------------- auth + display names ------------------- */
async function nadeoAccess() {
  if (!NADEO_REFRESH_TOKEN) throw new Error("Missing NADEO_REFRESH_TOKEN");
  const r = await fetch(`${CORE}/v2/authentication/token/refresh`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `nadeo_v1 t=${NADEO_REFRESH_TOKEN}` },
    body: JSON.stringify({ audience: "NadeoLiveServices" })
  });
  if (!r.ok) throw new Error(`refresh failed: ${r.status}`);
  const j = await r.json();
  return j.accessToken;
}
const nadeoHeaders = async () => ({ Authorization: `nadeo_v1 t=${await nadeoAccess()}` });

async function tmOAuth() {
  if (!TM_CLIENT_ID || !TM_CLIENT_SECRET) return null;
  const body = new URLSearchParams({
    grant_type: "client_credentials",
    client_id: TM_CLIENT_ID,
    client_secret: TM_CLIENT_SECRET,
    scope: "basic display-name"
  });
  const r = await fetch(`${OAUTH}/oauth/token`, {
    method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body
  });
  if (!r.ok) return null;
  const j = await r.json();
  return j.access_token;
}
async function resolveNames(ids) {
  if (!ids?.length) return {};
  const token = await tmOAuth(); if (!token) return {};
  const qs = ids.map(i => `accountId[]=${encodeURIComponent(i)}`).join("&");
  const r = await fetch(`${OAUTH}/api/display-names/account-ids?${qs}`, {
    headers: { Authorization: `Bearer ${token}` }
  });
  return r.ok ? r.json() : {};
}

/* ------------------- index helper ------------------- */
/** Rebuild months.json from *.json files present in the dir (excludes months.json). */
async function rebuildMonthIndex(dir) {
  await ensureDir(dir);
  const items = await readdir(dir, { withFileTypes: true });
  const months = items
    .filter(e => e.isFile() && e.name.endsWith(".json") && e.name !== "months.json")
    .map(e => e.name.replace(/\.json$/,""))
    .sort()
    .reverse();
  await writeJson(path.join(dir, "months.json"), { months });
}

/* ------------------- TOTD from trackmania.io (no auth) ------------------- */
async function fetchTmioMonth(index = 0) {
  const r = await fetch(`https://trackmania.io/api/totd/${index}`, {
    headers: { "User-Agent": "tm-cotd" }
  });
  if (!r.ok) throw new Error(`tm.io totd[${index}] failed: ${r.status}`);
  return r.json();
}
function normTmioEntry(y, m1, entry,idx) {
  const m = entry.map || entry;
  const uid   = m.mapUid ?? entry.mapUid ?? null;
  const name  = m.name ?? m.mapName ?? entry.name ?? "(unknown map)";
  const thumb = m.thumbnail ?? m.thumbnailUrl ?? entry.thumbnail ?? entry.thumbnailUrl ?? "";
  const authorAccountId =
    m.authorPlayer?.accountId ?? m.authorplayer?.accountid ??
    entry.authorPlayer?.accountId ?? entry.authorplayer?.accountid ?? null;
  const authorDisplayName =
    m.authorPlayer?.name ?? m.authorplayer?.name ?? m.authorName ?? m.author ??
    entry.authorPlayer?.name ?? entry.authorplayer?.name ?? "(unknown)";
  const d = tmioDayNumber(entry, idx);
  return {
    date: dateKey(y, m1, d),
    map: { uid, name, authorAccountId, authorDisplayName, thumbnailUrl: thumb }
  };
}
async function writeTotdMonth(index = 0) {
  const j = await fetchTmioMonth(index);
  const { year, month1 } = tmioMonthYear(j);
  const mKey = monthKey(year, month1);

  const daysOut = {};
  const daysArr = Array.isArray(j.days) ? j.days : [];
daysArr.forEach((entry, i) => {
  const rec = normTmioEntry(year, month1, entry, i);
  daysOut[rec.date] = rec;
});


  await ensureDir(TOTD_DIR);
  await writeJson(path.join(TOTD_DIR, `${mKey}.json`), { month: mKey, days: daysOut });

  // Always rebuild months.json so stale months disappear
  await rebuildMonthIndex(TOTD_DIR);

  return { mKey, daysOut };
}

/* ------------------- COTD winner (Meet API) ------------------- */
async function getCotdWinnerToday() {
  try {
    const curRes = await fetch(`${MEET}/api/cup-of-the-day/current`, { headers: await nadeoHeaders() });
    if (curRes.status === 204) return null;
    if (!curRes.ok) throw new Error(`COTD current failed: ${curRes.status}`);
    const cur = await curRes.json();
    const compId = cur?.competition?.id ?? cur?.competition?.liveId;
    if (!compId) return null;

    const roundsRes = await fetch(`${MEET}/api/competitions/${compId}/rounds`, { headers: await nadeoHeaders() });
    if (!roundsRes.ok) throw new Error(`rounds failed: ${roundsRes.status}`);
    const rounds = await roundsRes.json();
    if (!Array.isArray(rounds) || !rounds.length) return null;

    const finalRound =
      rounds.find(r => String(r?.name ?? "").toUpperCase().includes("FINAL")) ??
      rounds.reduce((a, b) => ((a?.position ?? 0) > (b?.position ?? 0) ? a : b));

    if (!finalRound?.id) return null;

    const matchesRes = await fetch(`${MEET}/api/rounds/${finalRound.id}/matches?length=1&offset=0`, { headers: await nadeoHeaders() });
    if (!matchesRes.ok) throw new Error(`matches failed: ${matchesRes.status}`);
    const matches = await matchesRes.json();
    const match = matches?.matches?.[0];
    if (!match?.id) return null;

    const resultsRes = await fetch(`${MEET}/api/matches/${match.id}/results?length=1`, { headers: await nadeoHeaders() });
    if (!resultsRes.ok) throw new Error(`results failed: ${resultsRes.status}`);
    const results = await resultsRes.json();
    return results?.results?.[0]?.participant ?? null;
  } catch {
    return null;
  }
}

/* ------------------- update month files + latest ------------------- */
async function upsertMonth(dir, key, dayKey, record) {
  await ensureDir(dir);
  const p = path.join(dir, `${key}.json`);
  const data = await loadJson(p, { month: key, days: {} });
  data.days[dayKey] = record;
  await writeJson(p, data);

  // Rebuild months index to keep it accurate
  await rebuildMonthIndex(dir);
}

/* ------------------- MAIN ------------------- */
async function main() {
  // 1) TOTD month from tm.io
  const { mKey, daysOut } = await writeTotdMonth(0);

  // 1a) Write "latest available" for TOTD (never falls back to 10-01)
  const keys = Object.keys(daysOut).sort();          // ascending YYYY-MM-DD
  const latestKey = keys[keys.length - 1] || null;
  if (latestKey) {
    const latestTotd = daysOut[latestKey];
    await writeJson(TOTD_LATEST, {
      generatedAt: new Date().toISOString(),
      ...latestTotd
    });
    console.log("TOTD latest:", latestTotd.date, latestTotd.map?.name);
  } else {
    console.log("TOTD: no days found for month", mKey);
  }

// 2) COTD: just the Division 1 winner for *today* (accumulates over time)
const now = new Date();
const todayKey = dateKey(
  now.getUTCFullYear(),
  now.getUTCMonth() + 1,
  now.getUTCDate()
);

const winnerId = await getCotdWinnerToday();
console.log("[COTD-FETCHER] winner:", winnerId ? `ok ${winnerId}` : "none");
const names = await resolveNames(winnerId ? [winnerId] : []);
const todayCotd = {
  date: todayKey,
  cotd: {
    winnerAccountId: winnerId || null,
    winnerDisplayName: (winnerId && names[winnerId]) || winnerId || null,
  }
};
await upsertMonth(COTD_DIR, mKey, todayKey, todayCotd);
await writeJson(COTD_LATEST, { generatedAt: new Date().toISOString(), ...todayCotd });

}

main().catch(err => { console.error(err); process.exit(1); });
