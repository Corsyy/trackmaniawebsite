// Node 20+ (native fetch)
import { mkdir, readFile, writeFile, access } from "node:fs/promises";
import { constants as FS } from "node:fs";
import path from "node:path";

const LIVE  = "https://live-services.trackmania.nadeo.live";
const MEET  = "https://meet.trackmania.nadeo.club";
const CORE  = "https://prod.trackmania.core.nadeo.online";
const OAUTH = "https://api.trackmania.com";

// === Secrets via GitHub Actions ===
// Use a long-lived Nadeo REFRESH token so we can mint fresh access tokens each run:
const NADEO_REFRESH_TOKEN = process.env.NADEO_REFRESH_TOKEN || "";
// For display names:
const TM_CLIENT_ID     = process.env.TM_CLIENT_ID || "";
const TM_CLIENT_SECRET = process.env.TM_CLIENT_SECRET || "";

// Outputs (can override in workflow env)
const OUTPUT_LATEST = process.env.COTD_OUTPUT   || "./cotd.json";
const COTD_DIR      = process.env.COTD_DATA_DIR || "./data/cotd";
const TOTD_DIR      = "./data/totd"; // fixed; adjust if you want via env

/* -------------------- Nadeo token via REFRESH -------------------- */
async function getNadeoAccessToken() {
  if (!NADEO_REFRESH_TOKEN) throw new Error("Missing NADEO_REFRESH_TOKEN");
  const r = await fetch(`${CORE}/v2/authentication/token/refresh`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `nadeo_v1 t=${NADEO_REFRESH_TOKEN}`
    },
    body: JSON.stringify({ audience: "NadeoLiveServices" })
  });
  if (!r.ok) throw new Error(`refresh failed: ${r.status}`);
  const j = await r.json();
  return j?.accessToken || null;
}
async function nadeoHeaders() {
  const at = await getNadeoAccessToken();
  return { Authorization: `nadeo_v1 t=${at}` };
}

/* -------------------- TM OAuth (display names) -------------------- */
async function getTmOAuthToken() {
  if (!TM_CLIENT_ID || !TM_CLIENT_SECRET) return null;
  const body = new URLSearchParams({
    grant_type: "client_credentials",
    client_id: TM_CLIENT_ID,
    client_secret: TM_CLIENT_SECRET,
    scope: "basic display-name"
  });
  const res = await fetch(`${OAUTH}/oauth/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body
  });
  if (!res.ok) return null;
  const j = await res.json();
  return j?.access_token || null;
}
async function resolveDisplayNames(accountIds) {
  if (!accountIds?.length) return {};
  const token = await getTmOAuthToken();
  if (!token) return {};
  const qs = accountIds.map(id => `accountId[]=${encodeURIComponent(id)}`).join("&");
  const r = await fetch(`${OAUTH}/api/display-names/account-ids?${qs}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!r.ok) return {};
  return await r.json();
}

/* -------------------- Helpers -------------------- */
function clean(s){ return typeof s === "string" ? s : ""; }
async function ensureDir(p){ await mkdir(p, { recursive: true }); }
async function exists(p){ try{ await access(p, FS.F_OK); return true; }catch{ return false; } }
async function loadJson(p, fallback){
  if (!(await exists(p))) return fallback;
  try { return JSON.parse(await readFile(p, "utf8")); } catch { return fallback; }
}

/* -------------------- TOTD (trackmania.io) -------------------- */
// index=0 current month, 1 previous, etc.
async function fetchTmioMonth(index=0){
  const r = await fetch(`https://trackmania.io/api/totd/${index}`, {
    headers: { "User-Agent": "tm-cotd-archiver" }
  });
  if (!r.ok) throw new Error(`tm.io totd[${index}] failed: ${r.status}`);
  return await r.json(); // { month:{year,month}, days:[{day,mapUid,name,author,authorPlayer?,thumbnail}] }
}
function yymmFromMonthObj(m){
  const yyyy = m?.year ?? new Date().getUTCFullYear();
  const mm = String((m?.month ?? (new Date().getUTCMonth()+1))).padStart(2,"0");
  return `${yyyy}-${mm}`;
}
function dayKey(yyyy,mm,dd){ return `${yyyy}-${mm}-${String(dd).padStart(2,"0")}`; }

/* -------------------- TODAY card (Nadeo first, tm.io fallback) -------------------- */
async function getTodaysTotdFromNadeo(){
  const monthRes = await fetch(`${LIVE}/api/token/campaign/month?length=1&offset=0`, { headers: await nadeoHeaders() });
  if (!monthRes.ok) throw new Error(`month campaign failed: ${monthRes.status}`);
  const data = await monthRes.json();
  const days = data?.monthList?.[0]?.days || [];
  if (!days.length) throw new Error("No TOTD days");
  const d = new Date(); const today = days.find(x=>x?.day===d.getUTCDate()) ?? days.at(-1);
  const mapUid = today?.mapUid; if(!mapUid) throw new Error("No mapUid");
  const mapRes = await fetch(`${LIVE}/api/token/map/${encodeURIComponent(mapUid)}`, { headers: await nadeoHeaders() });
  if (!mapRes.ok) throw new Error(`map fetch failed: ${mapRes.status}`);
  const j = await mapRes.json();
  return { uid:j.uid, name:j.name, authorAccountId:j.author, authorDisplayName:null, thumbnailUrl:j.thumbnailUrl, from:"nadeo" };
}
async function getTodaysTotdFromTmio(){
  const month = await fetchTmioMonth(0);
  const now = new Date();
  const entry = month?.days?.find(d=>d?.day===now.getUTCDate()) ?? month?.days?.at(-1);
  if(!entry) throw new Error("tm.io totd: no days");
  return {
    uid: entry.mapUid,
    name: entry.name,
    // Show a name even if we don't resolve accountId:
    authorAccountId: entry?.authorPlayer?.accountId || null,
    authorDisplayName: entry?.authorPlayer?.name || entry?.author || "(unknown)",
    thumbnailUrl: entry.thumbnail || entry.thumbnailUrl || "",
    from: "tmio",
  };
}
async function getTodaysMapCard(){
  try { return await getTodaysTotdFromNadeo(); }
  catch { return await getTodaysTotdFromTmio(); }
}

/* -------------------- COTD Winner (needs LiveServices) -------------------- */
async function getCotdWinnerAccountId() {
  try {
    const cur = await fetch(`${MEET}/api/cup-of-the-day/current`, { headers: await nadeoHeaders() });
    if (cur.status === 204) return null;
    if (!cur.ok) throw new Error(`COTD current failed: ${cur.status}`);
    const j = await cur.json();
    const compId = j?.competition?.id ?? j?.competition?.liveId;
    if (!compId) return null;

    const roundsRes = await fetch(`${MEET}/api/competitions/${compId}/rounds`, { headers: await nadeoHeaders() });
    if (!roundsRes.ok) throw new Error(`rounds failed: ${roundsRes.status}`);
    const rounds = await roundsRes.json();
    if (!Array.isArray(rounds) || !rounds.length) return null;

    const finalRound = rounds.find(r => String(r?.name ?? "").toUpperCase().includes("FINAL"))
                      ?? rounds.reduce((a,b)=>(a?.position??0)>(b?.position??0)?a:b);
    if (!finalRound?.id) return null;

    const matchesRes = await fetch(`${MEET}/api/rounds/${finalRound.id}/matches?length=1&offset=0`, { headers: await nadeoHeaders() });
    if (!matchesRes.ok) throw new Error(`matches failed: ${matchesRes.status}`);
    const matches = await matchesRes.json();
    const match = matches?.matches?.[0]; if(!match?.id) return null;

    const resultsRes = await fetch(`${MEET}/api/matches/${match.id}/results?length=1`, { headers: await nadeoHeaders() });
    if (!resultsRes.ok) throw new Error(`results failed: ${resultsRes.status}`);
    const results = await resultsRes.json();
    return results?.results?.[0]?.participant ?? null;
  } catch {
    return null; // fail soft (winner will be "—")
  }
}

/* -------------------- Writers -------------------- */
async function writeLatest(payload){
  await writeFile(OUTPUT_LATEST, JSON.stringify(payload, null, 2), "utf8");
  console.log(`Wrote ${OUTPUT_LATEST}`);
}
async function writeMonthIndex(dir, key){
  await ensureDir(dir);
  const idxPath = path.join(dir, "months.json");
  const idx = await loadJson(idxPath, { months: [] });
  if (!idx.months.includes(key)) {
    idx.months.push(key);
    idx.months.sort().reverse();
    await writeFile(idxPath, JSON.stringify(idx, null, 2), "utf8");
    console.log(`Wrote ${idxPath}`);
  }
}
async function upsertMonthFile(dir, key, dayKeyStr, record){
  await ensureDir(dir);
  const p = path.join(dir, `${key}.json`);
  const data = await loadJson(p, { month: key, days: {} });
  data.days[dayKeyStr] = record;
  await writeFile(p, JSON.stringify(data, null, 2), "utf8");
  console.log(`Wrote ${p}`);
}

/* -------------------- TOTD monthly writer -------------------- */
async function saveTotdMonth(index=0){
  const j = await fetchTmioMonth(index);
  const key = yymmFromMonthObj(j?.month);
  await ensureDir(TOTD_DIR);

  // Normalize structure
  const daysOut = {};
  const yyyy = j?.month?.year, mm = String(j?.month?.month).padStart(2,"0");
  for (const d of (j?.days||[])) {
    const dk = dayKey(yyyy, mm, d.day);
    daysOut[dk] = {
      date: dk,
      map: {
        uid: d.mapUid,
        name: d.name,
        authorAccountId: d?.authorPlayer?.accountId || null,
        authorDisplayName: d?.authorPlayer?.name || d?.author || "(unknown)",
        thumbnailUrl: d.thumbnail || d.thumbnailUrl || ""
      }
    };
  }
  const out = { month: key, days: daysOut };
  const p = path.join(TOTD_DIR, `${key}.json`);
  await writeFile(p, JSON.stringify(out, null, 2), "utf8");
  console.log(`Wrote ${p}`);
  await writeMonthIndex(TOTD_DIR, key);
  return { key, daysOut };
}

/* -------------------- COTD monthly: backfill from TOTD if missing -------------------- */
async function backfillCotdWithTotdForMonth(key, totdDays){
  await ensureDir(COTD_DIR);
  const p = path.join(COTD_DIR, `${key}.json`);
  const cotd = await loadJson(p, { month: key, days: {} });

  // add any missing days with map info (winner null)
  for (const [dk, rec] of Object.entries(totdDays)) {
    if (!cotd.days[dk]) {
      cotd.days[dk] = {
        date: dk,
        map: rec.map,
        cotd: { winnerAccountId: null, winnerDisplayName: null }
      };
    }
  }
  await writeFile(p, JSON.stringify(cotd, null, 2), "utf8");
  console.log(`Backfilled ${p}`);
  await writeMonthIndex(COTD_DIR, key);
}

/* -------------------- MAIN -------------------- */
async function main(){
  // TODAY snapshot
  const map = await getTodaysMapCard();
  const winnerId = await getCotdWinnerAccountId();

  const toResolve = [map.authorAccountId, ...(winnerId ? [winnerId] : [])].filter(Boolean);
  const names = await resolveDisplayNames(toResolve);

  const payload = {
    generatedAt: new Date().toISOString(),
    map: {
      uid: map.uid,
      name: clean(map.name),
      authorAccountId: map.authorAccountId || null,
      authorDisplayName: map.authorDisplayName || (map.authorAccountId && names[map.authorAccountId]) || map.authorAccountId || "(unknown)",
      thumbnailUrl: map.thumbnailUrl || "",
      source: map.from, // "nadeo" or "tmio"
    },
    cotd: {
      winnerAccountId: winnerId || null,
      winnerDisplayName: (winnerId && names[winnerId]) || winnerId || null,
    },
  };

  await writeLatest(payload);

  // MONTH files:
  // 1) Write TOTD month (index=0 current month)
  const { key, daysOut } = await saveTotdMonth(0);

  // 2) Ensure COTD month exists and is backfilled with all days’ map info
  await backfillCotdWithTotdForMonth(key, daysOut);

  // 3) Also insert TODAY into COTD month (so winner is present when available)
  const now = new Date();
  const mmKey = `${now.getUTCFullYear()}-${String(now.getUTCMonth()+1).padStart(2,"0")}`;
  const dk = `${mmKey}-${String(now.getUTCDate()).padStart(2,"0")}`;
  await upsertMonthFile(COTD_DIR, mmKey, dk, {
    date: dk,
    map: payload.map,
    cotd: payload.cotd
  });
}

main().catch(err => { console.error(err); process.exit(1); });
