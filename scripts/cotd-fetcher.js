// scripts/cotd-fetcher.js  (Node 20+)
import { mkdir, readFile, writeFile, access } from "node:fs/promises";
import { constants as FS } from "node:fs";
import path from "node:path";

const LIVE  = "https://live-services.trackmania.nadeo.live";
const MEET  = "https://meet.trackmania.nadeo.club";
const CORE  = "https://prod.trackmania.core.nadeo.online";
const OAUTH = "https://api.trackmania.com";

// Secrets (GitHub Actions -> repo Secrets)
const NADEO_REFRESH_TOKEN = process.env.NADEO_REFRESH_TOKEN || "";
const TM_CLIENT_ID     = process.env.TM_CLIENT_ID || "";
const TM_CLIENT_SECRET = process.env.TM_CLIENT_SECRET || "";

// Output roots (change in workflow if needed)
const COTD_DIR  = process.env.COTD_DATA_DIR || "./data/cotd";
const TOTD_DIR  = "./data/totd";
const COTD_LATEST = "./cotd.json";
const TOTD_LATEST = "./totd.json";

/* ------------ small fs helpers ------------ */
const clean = s => (typeof s === "string" ? s : "");
const ensureDir = p => mkdir(p, { recursive: true });
const exists = async p => { try { await access(p, FS.F_OK); return true; } catch { return false; } };
const loadJson = async (p, f) => (await exists(p)) ? JSON.parse(await readFile(p, "utf8")) : f;

/* ------------ Nadeo access via refresh token ------------ */
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

/* ------------ Display names (optional nicety) ------------ */
async function tmOAuth() {
  if (!TM_CLIENT_ID || !TM_CLIENT_SECRET) return null;
  const body = new URLSearchParams({
    grant_type: "client_credentials",
    client_id: TM_CLIENT_ID,
    client_secret: TM_CLIENT_SECRET,
    scope: "basic display-name"
  });
  const r = await fetch(`${OAUTH}/oauth/token`, { method: "POST", headers:{ "Content-Type":"application/x-www-form-urlencoded" }, body });
  if (!r.ok) return null;
  return (await r.json()).access_token;
}
async function resolveNames(ids) {
  if (!ids?.length) return {};
  const tok = await tmOAuth(); if (!tok) return {};
  const qs = ids.map(i => `accountId[]=${encodeURIComponent(i)}`).join("&");
  const r = await fetch(`${OAUTH}/api/display-names/account-ids?${qs}`, { headers: { Authorization:`Bearer ${tok}` }});
  return r.ok ? r.json() : {};
}

/* ------------ TOTD (trackmania.io, no auth) ------------ */
function monthKey(y, m){ return `${y}-${String(m).padStart(2,"0")}`; }
function dateKey(y,m,d){ return `${y}-${String(m).padStart(2,"0")}-${String(d).padStart(2,"0")}`; }

function pick(vals, fallback){ for (const v of vals){ if (v !== undefined && v !== null && v !== "") return v; } return fallback; }

async function fetchTmioMonth(index=0){
  const r = await fetch(`https://trackmania.io/api/totd/${index}`, { headers: { "User-Agent":"tm-cotd" }});
  if (!r.ok) throw new Error(`tm.io totd[${index}] failed: ${r.status}`);
  return r.json();
}

function normalizeTmioDay(y, m, d){
  const mobj = d.map || d;
  const uid   = pick([mobj.mapUid, d.mapUid], null);
  const name  = pick([mobj.name, mobj.mapName, d.name], "(unknown map)");
  const thumb = pick([mobj.thumbnail, mobj.thumbnailUrl, d.thumbnail, d.thumbnailUrl], "");
  const authorId = pick([
    mobj.authorPlayer?.accountId, mobj.authorplayer?.accountid, mobj.author_accountid,
    d.authorPlayer?.accountId, d.authorplayer?.accountid
  ], null);
  const authorName = pick([
    mobj.authorPlayer?.name, mobj.authorplayer?.name, mobj.authorName, mobj.author,
    d.authorPlayer?.name, d.authorplayer?.name
  ], "(unknown)");
  return {
    uid, name,
    authorAccountId: authorId,
    authorDisplayName: authorName,
    thumbnailUrl: thumb
  };
}

async function writeTotdMonth(index=0){
  const j = await fetchTmioMonth(index);
  const y = j?.month?.year ?? new Date().getUTCFullYear();
  const m = j?.month?.month ?? (new Date().getUTCMonth()+1);
  const key = monthKey(y,m);

  const days = {};
  for (const d of (j.days||[])){
    const dk = dateKey(y,m,d.day);
    days[dk] = { date: dk, map: normalizeTmioDay(y,m,d) };
  }

  await ensureDir(TOTD_DIR);
  await writeFile(path.join(TOTD_DIR, `${key}.json`), JSON.stringify({ month:key, days }, null, 2));
  const idxPath = path.join(TOTD_DIR, "months.json");
  const idx = await loadJson(idxPath, { months: [] });
  if (!idx.months.includes(key)){ idx.months.push(key); idx.months.sort().reverse(); await writeFile(idxPath, JSON.stringify(idx, null, 2)); }
  return { key, days };
}

/* ------------ COTD winner (Meet; needs Nadeo token) ------------ */
async function getCotdWinnerToday() {
  try{
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

    const final = rounds.find(r => String(r?.name??"").toUpperCase().includes("FINAL"))
               ?? rounds.reduce((a,b)=>((a?.position??0)>(b?.position??0)?a:b));
    if (!final?.id) return null;

    const matches = await fetch(`${MEET}/api/rounds/${final.id}/matches?length=1&offset=0`, { headers: await nadeoHeaders() }).then(r=>r.json());
    const match = matches?.matches?.[0]; if (!match?.id) return null;

    const results = await fetch(`${MEET}/api/matches/${match.id}/results?length=1`, { headers: await nadeoHeaders() }).then(r=>r.json());
    return results?.results?.[0]?.participant ?? null;
  }catch{ return null; }
}

/* ------------ Writers (month + index + latest) ------------ */
async function upsertMonth(dir, key, dk, record){
  await ensureDir(dir);
  const p = path.join(dir, `${key}.json`);
  const data = await loadJson(p, { month:key, days:{} });
  data.days[dk] = record;
  await writeFile(p, JSON.stringify(data, null, 2));
  const idxP = path.join(dir, "months.json");
  const idx = await loadJson(idxP, { months: [] });
  if (!idx.months.includes(key)){ idx.months.push(key); idx.months.sort().reverse(); await writeFile(idxP, JSON.stringify(idx, null, 2)); }
}

/* ------------ MAIN ------------ */
async function main(){
  // 1) TOTD: build/refresh current month from tm.io (author + map)
  const { key: totdKey, days: totdDays } = await writeTotdMonth(0);

  // 1a) Latest TOTD (today)
  const today = new Date(); const dk = dateKey(today.getUTCFullYear(), today.getUTCMonth()+1, today.getUTCDate());
  const todaysTotd = totdDays[dk] || Object.values(totdDays).at(-1);
  await writeFile(TOTD_LATEST, JSON.stringify({ generatedAt:new Date().toISOString(), ...todaysTotd }, null, 2));

  // 2) COTD: just store winner for today (fills month over time). Winner needs Nadeo.
  const winnerId = await getCotdWinnerToday();
  const names = await resolveNames(winnerId ? [winnerId] : []);
  const cotdRecord = {
    date: dk,
    cotd: {
      winnerAccountId: winnerId || null,
      winnerDisplayName: (winnerId && names[winnerId]) || winnerId || null
    }
  };
  await upsertMonth(COTD_DIR, totdKey, dk, cotdRecord);
  await writeFile(COTD_LATEST, JSON.stringify({ generatedAt:new Date().toISOString(), ...cotdRecord }, null, 2));
}

main().catch(e=>{ console.error(e); process.exit(1); });
