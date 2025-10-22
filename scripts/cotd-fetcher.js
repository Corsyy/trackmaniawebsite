// scripts/cotd-fetcher.js (patched with deeper COTD fallbacks + logging)
// Node 18+ required (global fetch).

import { mkdir, writeFile, readFile, access, readdir } from "node:fs/promises";
import { constants as FS } from "node:fs";
import path from "node:path";

/* --------------------------------- constants -------------------------------- */
const PUBLIC_DIR = process.env.PUBLIC_DIR || ".";
const COTD_DIR = `${PUBLIC_DIR.replace(/\/+$/,"")}/data/cotd`;
const TOTD_DIR = `${PUBLIC_DIR.replace(/\/+$/,"")}/data/totd`;
const COTD_LATEST = `${PUBLIC_DIR.replace(/\/+$/,"")}/cotd.json`;
const TOTD_LATEST = `${PUBLIC_DIR.replace(/\/+$/,"")}/totd.json`;

const LIVE = "https://live-services.trackmania.nadeo.live";
const MEET = "https://meet.trackmania.nadeo.club";
const CORE = "https://prod.trackmania.core.nadeo.online";
const TMIO = "https://trackmania.io";

/* 🔐 separate refresh tokens for each audience */
const NADEO_LIVE_REFRESH_TOKEN = process.env.NADEO_LIVE_REFRESH_TOKEN || "";
const NADEO_CORE_REFRESH_TOKEN = process.env.NADEO_CORE_REFRESH_TOKEN || ""; // optional, for display names
const USER_AGENT = process.env.USER_AGENT || "CorsySite/1.0";

const DEBUG = process.env.DEBUG === "1";
const dlog = (...a)=>{ if (DEBUG) console.log("[FETCHER]",...a); };

/* --------------------------------- fs utils --------------------------------- */
const ensureDir = (p)=>mkdir(p,{recursive:true});
const exists = async(p)=>{ try{ await access(p,FS.F_OK); return true; } catch { return false; } };
const loadJson = async(p,f)=>(await exists(p))?JSON.parse(await readFile(p,"utf8")):f;
const writeJson=(p,obj)=>writeFile(p,JSON.stringify(obj,null,2),"utf8");

/* -------------------------------- date utils -------------------------------- */
const pad2=(n)=>String(n).padStart(2,"0");
const monthKey=(y,m1)=>`${y}-${pad2(m1)}`;
const dateKey=(y,m1,d)=>`${y}-${pad2(m1)}-${pad2(d)}`;
function* daysOfMonth(year,month1){ const days=new Date(Date.UTC(year,month1,0)).getUTCDate(); for(let d=1; d<=days; d++) yield d; }
function clampToToday(y,m1,d){ const now=new Date(); const ny=now.getUTCFullYear(), nm1=now.getUTCMonth()+1, nd=now.getUTCDate(); if(y>ny)return false; if(y===ny&&m1>nm1)return false; if(y===ny&&m1===nm1&&d>nd)return false; return true; }

/* ------------------------------ fetch + retry ------------------------------- */
async function sleep(ms){ return new Promise(r=>setTimeout(r,ms)); }
async function fetchRetry(url,opts={},retries=5,baseDelay=500){
  let lastErr;
  for(let i=0;i<=retries;i++){
    try{
      const r=await fetch(url,opts);
      if(r.status===429 || (r.status>=500 && r.status<=599)){
        const wait=Math.min(baseDelay*Math.pow(2,i),8000);
        await sleep(wait);
        continue;
      }
      return r;
    }catch(e){
      lastErr=e;
      const wait=Math.min(baseDelay*Math.pow(2,i),8000);
      await sleep(wait);
    }
  }
  throw lastErr || new Error(`fetch failed for ${url}`);
}

/* ----------------------------------- auth ----------------------------------- */
if(!NADEO_LIVE_REFRESH_TOKEN){
  console.error("ERROR: Missing NADEO_LIVE_REFRESH_TOKEN env.");
  process.exit(1);
}

const tokenCache=new Map(); // audience -> { token, expAt }

function getRefreshFor(audience){
  if(audience === "NadeoLiveServices") return NADEO_LIVE_REFRESH_TOKEN;
  if(audience === "NadeoServices")     return NADEO_CORE_REFRESH_TOKEN; // may be empty (names become null)
  throw new Error(`unknown audience ${audience}`);
}

async function refreshForAudience(audience){
  const refreshToken = getRefreshFor(audience);
  if(!refreshToken) throw new Error(`Missing refresh token for ${audience} (set NADEO_CORE_REFRESH_TOKEN if you want display names).`);

  const r=await fetch(`${CORE}/v2/authentication/token/refresh`,{
    method:"POST",
    headers:{
      Authorization: refreshToken,   // token already includes "nadeo_v1 t="
      "User-Agent": USER_AGENT,
      Accept: "application/json"
    }
  });

  if(!r.ok){
    const txt=await r.text().catch(()=> "");
    throw new Error(`refresh(${audience}) failed: ${r.status} ${txt}`);
  }
  const j=await r.json(); // { accessToken, refreshToken, expiration }
  const token=j.accessToken; // already "nadeo_v1 t=..."
  const expAt= Date.parse(j.expiration || "") || (Date.now()+50*60*1000);
  tokenCache.set(audience,{ token, expAt });
  return token;
}

async function getToken(audience){
  const entry=tokenCache.get(audience);
  if(entry && Date.now()<entry.expAt-10000) return entry.token;
  return refreshForAudience(audience);
}

async function authedFetch(url,{audience,init={},retryOnAuth=true}={}){
  let token=await getToken(audience);
  let r=await fetch(url,{
    ...init,
    headers:{ ...(init.headers||{}), Authorization: token, "User-Agent": USER_AGENT, Accept: "application/json" }
  });
  if(retryOnAuth && (r.status===401||r.status===403)){
    token=await refreshForAudience(audience);
    r=await fetch(url,{...init, headers:{ ...(init.headers||{}), Authorization: token, "User-Agent": USER_AGENT, Accept: "application/json" }});
  }
  return r;
}

// Meet/Live need NadeoLiveServices; Core needs NadeoServices.
const fetchMeet=(url,init={})=>authedFetch(url,{ audience:"NadeoLiveServices", init });
const fetchCore=(url,init={})=>authedFetch(url,{ audience:"NadeoServices", init });

/* ------------------------------- month indices ------------------------------ */
async function rebuildMonthIndex(dir){
  await ensureDir(dir);
  const items=await readdir(dir,{withFileTypes:true});
  const months=items
    .filter(e=>e.isFile()&&e.name.endsWith(".json")&&e.name!=="months.json"&&!e.name.startsWith("_"))
    .map(e=>e.name.replace(/\.json$/,""))
    .sort().reverse();
  await writeJson(path.join(dir,"months.json"),{ months });
}

/* ---------------------------------- TOTD ------------------------------------ */
function stripTmFormatting(input){
  if(!input || typeof input!=="string") return input;
  const D="\uFFF0";
  let s=input.replace(/\$\$/g,D);
  s=s.replace(/\$[0-9a-fA-F]{1,3}|\$[a-zA-Z]|\$[<>\[\]\(\)]/g,"");
  return s.replace(new RegExp(D,"g"),"$");
}
function toMs(dt){
  if(dt==null) return NaN;
  let n=typeof dt==="string"?Number(dt):dt;
  if(Number.isFinite(n)){ if(n<2e12) n*=1000; return n; }
  const p=Date.parse(dt);
  return Number.isFinite(p)?p:NaN;
}
function extractWinnerFields(result){
  const p=result?.participant??result?.player??null;
  let accountId=null, displayName=null;
  if(typeof p==="string") accountId=p;
  if(!accountId && p && typeof p==="object"){
    accountId=p.accountId||p.id||p.player?.accountId||p.player?.id||null;
    displayName=p.displayName||p.name||p.player?.displayName||p.player?.name||result?.displayName||result?.name||null;
  }
  if(!displayName) displayName=result?.playerName||result?.nickname||null;
  return { accountId: accountId||null, displayName: displayName||null };
}

/* keep tm.io for TOTD (this worked in your CI) */
async function fetchTmioMonth(index=0){
  const r=await fetchRetry(`${TMIO}/api/totd/${index}`,{ headers:{ "User-Agent":"tm-cotd" }});
  if(!r.ok) throw new Error(`tm.io totd[${index}] failed: ${r.status}`);
  return r.json();
}
function tmioMonthYear(resp){
  const y=resp?.month?.year??new Date().getUTCFullYear();
  const m1=(resp?.month?.month??new Date().getUTCMonth())+1;
  return { y,m1 };
}
function tmioDayNumber(dayObj,idx){ return dayObj?.day??dayObj?.dayIndex??dayObj?.monthDay??dayObj?.dayInMonth??(idx+1); }
function normTmioEntry(y,m1,entry,idx){
  const m=entry.map||entry;
  const uid=m.mapUid??entry.mapUid??null;
  let name=m.name??m.mapName??entry.name??"(unknown map)";
  let authorDisplayName=m.authorPlayer?.name??m.authorplayer?.name??m.authorName??m.author??entry.authorPlayer?.name??entry.authorplayer?.name??"(unknown)";
  const thumb=m.thumbnail??m.thumbnailUrl??entry.thumbnail??entry.thumbnailUrl??"";
  const authorAccountId=m.authorPlayer?.accountId??m.authorplayer?.accountid??entry.authorPlayer?.accountId??entry.authorplayer?.accountid??null;
  const d=tmioDayNumber(entry,idx);
  name=stripTmFormatting(name); authorDisplayName=stripTmFormatting(authorDisplayName);
  return { date:dateKey(y,m1,d), map:{ uid,name,authorAccountId,authorDisplayName,thumbnailUrl:thumb } };
}
async function writeTotdMonth(index=0){
  const j=await fetchTmioMonth(index);
  const {y,m1}=tmioMonthYear(j);
  const mKey=monthKey(y,m1);
  const daysOut={};
  (Array.isArray(j.days)?j.days:[]).forEach((entry,i)=>{
    const rec=normTmioEntry(y,m1,entry,i);
    daysOut[rec.date]=rec;
  });
  await ensureDir(TOTD_DIR);
  await writeJson(path.join(TOTD_DIR,`${mKey}.json`),{ month:mKey, days:daysOut });
  await rebuildMonthIndex(TOTD_DIR);
  const keys=Object.keys(daysOut).sort();
  const latestKey=keys[keys.length-1]||null;
  if(latestKey){
    const latestTotd=daysOut[latestKey];
    await writeJson(TOTD_LATEST,{ generatedAt:new Date().toISOString(), ...latestTotd });
    dlog("TOTD latest:", latestTotd.date, latestTotd.map?.name);
  }else{
    dlog("TOTD: no days found for", mKey);
  }
  return { mKey, daysOut };
}

/* ---------------------------------- COTD ------------------------------------ */
function looksLikeCotd(c){
  const name=String(c?.name||"").toLowerCase();
  return name.includes("cup of the day") || name.includes("cotd") || /\bday\b/.test(name) || /#\d{1,3}/.test(name) || name.includes("cup du jour");
}
async function listCompetitions(offset=0,length=100){
  const r=await fetchMeet(`${MEET}/api/competitions?offset=${offset}&length=${length}`);
  if(!r.ok) throw new Error(`competitions list failed: ${r.status}`);
  return r.json();
}
async function findCotdCompetitionByDate(y,m1,d){
  const dayStart=Date.UTC(y,m1-1,d,0,0,0), dayEnd=Date.UTC(y,m1-1,d,23,59,59,999);
  const PAGE_LEN=100, MAX_PAGES=80, hits=[];
  for(let page=0; page<MAX_PAGES; page++){
    const offset=page*PAGE_LEN;
    const data=await listCompetitions(offset,PAGE_LEN);
    const comps=Array.isArray(data)?data:(data?.competitions||data?.items||[]);
    if(!Array.isArray(comps)||!comps.length) break;
    for(const c of comps){
      const dtRaw=c.startDate??c.beginDate??c.startTime??c.beginTime??c.date??null;
      const ts=toMs(dtRaw); if(!Number.isFinite(ts)) continue;
      if(ts<dayStart||ts>dayEnd) continue;
      if(!looksLikeCotd(c)) continue;
      hits.push(c);
    }
    if(comps.length<PAGE_LEN) break;
  }
  if(!hits.length){ dlog(`[COTD] ${y}-${String(m1).padStart(2,"0")}-${String(d).padStart(2,"0")} – scanned pages, no COTD-like comps matched name`); return null; }
  const ymd=`${y}-${pad2(m1)}-${pad2(d)}`;
  let pick=hits.find(c=>String(c?.name??"").includes(ymd));
  if(!pick){
    pick=hits.reduce((best,cur)=>{
      const bt=toMs(best?.startDate??best?.beginDate??best?.startTime??best?.beginTime);
      const ct=toMs(cur?.startDate ??cur?.beginDate ??cur?.startTime ??cur?.beginTime);
      return ct<bt?cur:best;
    },hits[0]);
  }
  dlog(`[COTD] PICK ${ymd}: id=${pick?.id||pick?.liveId||"?"} name="${pick?.name??"(no name)"}"`);
  return pick||null;
}

/* --- TODAY helper: authoritative current COTD --- */
async function getCurrentCotd(){
  const r = await fetchMeet(`${MEET}/api/cup-of-the-day/current`);
  if (r.status === 204) return null;
  if (!r.ok) return null;
  return r.json(); // { competition: { id, name, ... }, ... }
}

/* ---------- path A: competition leaderboard (first place = winner) ---------- */
async function getWinnerFromCompetitionLeaderboard(compId){
  try{
    const url = `${MEET}/api/competitions/${compId}/leaderboard?length=1&offset=0`;
    const r = await fetchMeet(url);
    if (DEBUG) dlog(`[winner] comp LB http=${r.status} id=${compId}`);
    if (r.status===204) return null;
    if (!r.ok) return null;

    const raw = await r.text();
    if (!raw || !raw.trim()) return null;
    let j; try { j = JSON.parse(raw); } catch { return null; }

    const pickFirst = (arr)=> {
      if (!Array.isArray(arr) || !arr.length) return null;
      const { accountId, displayName } = extractWinnerFields(arr[0]);
      return (accountId||displayName) ? { displayName: displayName||null, accountId: accountId||null, via:"competitionLB" } : null;
    };

    let winner = null;
    if (Array.isArray(j)) winner = pickFirst(j);
    if (!winner && j && typeof j==="object"){
      winner = pickFirst(j.leaderboard) || pickFirst(j.top) || pickFirst(j.results) ||
               pickFirst(j.ranks) || pickFirst(j.players) || pickFirst(j.items);
    }

    if(!winner && DEBUG){
      const keys = (j && typeof j==="object") ? Object.keys(j) : [];
      dlog(`[winner] comp LB unknown shape id=${compId} keys=${keys.join(",")}`);
    }
    return winner || null;
  }catch(e){
    if (DEBUG) dlog(`[winner] comp LB error id=${compId}: ${e.message}`);
    return null;
  }
}

/* ------------------- path B: D1 match results (fallback) -------------------- */
async function getD1WinnerForCompetition(compId) {
  if (!compId) return null;

  const roundsRes = await fetchMeet(`${MEET}/api/competitions/${compId}/rounds`);
  if (!roundsRes.ok) {
    if (DEBUG) dlog(`[winner] rounds ${compId} http=${roundsRes.status}`);
    return null; // soft fail (some comps return 401/403 here)
  }
  const rounds = await roundsRes.json();
  if (!Array.isArray(rounds) || !rounds.length) return null;

  const PAGE = 100;
  const allMatches = [];
  for (const round of rounds) {
    for (let offset = 0; offset < 2000; offset += PAGE) {
      const res = await fetchMeet(`${MEET}/api/rounds/${round.id}/matches?length=${PAGE}&offset=${offset}`);
      if (!res.ok) break;
      const j = await res.json();
      const batch = j?.matches || j || [];
      if (!batch.length) break;
      for (const m of batch) allMatches.push({ ...m, _round: round });
      if (batch.length < PAGE) break;
    }
  }

  if (DEBUG) dlog(`[winner] total matches fetched=${allMatches.length} comp=${compId}`);
  if (!allMatches.length) return null;

  const lc = (s) => String(s || "").toLowerCase();
  let d1 =
    allMatches.find((m) => /\bdivision\s*1\b|\bdiv\s*1\b|\bd1\b/.test(lc(m.name))) ||
    allMatches.find((m) => (m.division ?? m.Division ?? m.divisionNumber) === 1);

  if (!d1) {
    const lastRound = rounds.reduce((a, b) => ((a?.position ?? -1) > (b?.position ?? -1) ? a : b), rounds[0]);
    const inLast = allMatches.filter((m) => m._round?.id === lastRound.id);
    const pool = inLast.length ? inLast : allMatches;
    d1 = pool.reduce((best, cur) => {
      const bp = best?.position ?? best?.number ?? Number.POSITIVE_INFINITY;
      const cp = cur?.position ?? cur?.number ?? Number.POSITIVE_INFINITY;
      return cp < bp ? cur : best;
    }, pool[0]);
  }

  if (!d1?.id) return null;

  const resultsRes = await fetchMeet(`${MEET}/api/matches/${d1.id}/results?length=255&offset=0`);
  if (!resultsRes.ok) return null;
  const resultsJ = await resultsRes.json();
  const arr = resultsJ?.results || resultsJ?.participants || resultsJ || [];
  if (!Array.isArray(arr) || !arr.length) return null;

  arr.sort((a, b) => {
    const ar = a.rank ?? a.position ?? Infinity;
    const br = b.rank ?? b.position ?? Infinity;
    if (ar !== br) return ar - br;
    const ap = typeof a.points === "number" ? -a.points : 0;
    const bp = typeof b.points === "number" ? -b.points : 0;
    return ap - bp;
  });

  const top = arr[0];
  const { accountId, displayName } = extractWinnerFields(top);
  return { accountId: accountId || null, displayName: displayName || null, rank: top.rank ?? top.position ?? 1 };
}

/* ------------------- path C: edition-level fallbacks ------------------------ */
async function getCompetitionEditions(compId){
  const r = await fetchMeet(`${MEET}/api/competitions/${compId}/editions?length=50&offset=0`);
  dlog(`[winner] editions comp=${compId} http=${r.status}`);
  if (!r.ok) return [];
  const j = await r.json();
  const arr = Array.isArray(j) ? j : (j?.editions || j?.items || []);
  dlog(`[winner] editions count=${arr.length} comp=${compId}`);
  return arr;
}

async function getEditionLeaderboardWinner(editionId){
  const r = await fetchMeet(`${MEET}/api/editions/${editionId}/leaderboard?length=1&offset=0`);
  dlog(`[winner] edition LB eid=${editionId} http=${r.status}`);
  if (r.status === 204) return null;
  if (!r.ok) return null;
  const raw = await r.text();
  if (!raw || !raw.trim()) return null;
  let j; try { j = JSON.parse(raw); } catch { return null; }
  const arr = Array.isArray(j) ? j : (j?.leaderboard || j?.top || j?.results || j?.items || []);
  if (!Array.isArray(arr) || !arr.length) return null;
  const { accountId, displayName } = extractWinnerFields(arr[0]);
  return (accountId||displayName) ? { accountId: accountId||null, displayName: displayName||null, via: "editionLB" } : null;
}

async function getEditionRankingWinner(editionId){
  const r = await fetchMeet(`${MEET}/api/editions/${editionId}/ranking?length=1&offset=0`);
  dlog(`[winner] edition ranking eid=${editionId} http=${r.status}`);
  if (!r.ok) return null;
  const j = await r.json();
  const arr = Array.isArray(j) ? j : (j?.ranking || j?.items || []);
  if (!Array.isArray(arr) || !arr.length) return null;
  const { accountId, displayName } = extractWinnerFields(arr[0]);
  return (accountId||displayName) ? { accountId: accountId||null, displayName: displayName||null, via: "editionRanking" } : null;
}

async function listEditionMatches(editionId){
  const PAGE = 100;
  const matches = [];
  for(let offset=0; offset<2000; offset+=PAGE){
    const r = await fetchMeet(`${MEET}/api/editions/${editionId}/matches?length=${PAGE}&offset=${offset}`);
    dlog(`[winner] edition matches eid=${editionId} http=${r.status} offset=${offset}`);
    if (!r.ok) break;
    const j = await r.json();
    const batch = j?.matches || j || [];
    if (!batch.length) break;
    matches.push(...batch);
    if (batch.length < PAGE) break;
  }
  return matches;
}

async function getEditionWinnerFallback(compId){
  try{
    let detail = null, editionId = null;
    try { detail = await getCompetitionDetail(compId); } catch(e){ dlog(`[winner] detail fail comp=${compId} ${e.message}`); }
    editionId = extractEditionId(detail);
    dlog(`[winner] editionId from detail comp=${compId} -> ${editionId}`);

    if (!editionId) {
      const eds = await getCompetitionEditions(compId);
      if (Array.isArray(eds) && eds.length) {
        eds.sort((a,b)=>(b.position??b.number??0)-(a.position??a.number??0));
        editionId = eds[0]?.id || eds.at(-1)?.id || null;
      }
      dlog(`[winner] editionId from list comp=${compId} -> ${editionId}`);
    }
    if (!editionId) return null;

    // C1: edition leaderboard top-1
    const lbWinner = await getEditionLeaderboardWinner(editionId);
    if (lbWinner) return lbWinner;

    // C2: edition ranking top-1 (some comps only expose this)
    const rkWinner = await getEditionRankingWinner(editionId);
    if (rkWinner) return rkWinner;

    // C3: edition matches -> results
    const matches = await listEditionMatches(editionId);
    dlog(`[winner] edition matches count=${matches.length} eid=${editionId}`);
    if (!matches.length) return null;

    const lc = s => String(s||"").toLowerCase();
    let final = matches.find(m => /\bdivision\s*1\b|\bdiv\s*1\b|\bd1\b/.test(lc(m.name))) ||
                matches.reduce((best,cur)=>{
                  const bp = best?.position ?? best?.number ?? -1;
                  const cp = cur?.position ?? cur?.number ?? -1;
                  return cp > bp ? cur : best;
                }, matches[0]);

    if (!final?.id) return null;

    const res = await fetchMeet(`${MEET}/api/matches/${final.id}/results?length=255&offset=0`);
    dlog(`[winner] edition final match results http=${res.status} mid=${final.id}`);
    if (!res.ok) return null;
    const J = await res.json();
    const arr = J?.results || J?.participants || J || [];
    if (!Array.isArray(arr) || !arr.length) return null;

    arr.sort((a,b)=>{
      const ar = a.rank ?? a.position ?? Infinity;
      const br = b.rank ?? b.position ?? Infinity;
      if (ar !== br) return ar - br;
      const ap = typeof a.points === "number" ? -a.points : 0;
      const bp = typeof b.points === "number" ? -b.points : 0;
      return ap - bp;
    });

    const top = arr[0];
    const { accountId, displayName } = extractWinnerFields(top);
    return (accountId||displayName) ? { accountId: accountId||null, displayName: displayName||null, via: "editionMatches" } : null;
  }catch(e){
    dlog(`[winner] edition fallback error comp=${compId}: ${e.message}`);
    return null;
  }
}

/* ------------------- path D: competition matches (direct) ------------------- */
async function listCompetitionMatches(compId){
  const PAGE = 100;
  const matches = [];
  for(let offset=0; offset<2000; offset+=PAGE){
    const r = await fetchMeet(`${MEET}/api/competitions/${compId}/matches?length=${PAGE}&offset=${offset}`);
    dlog(`[winner] comp matches comp=${compId} http=${r.status} offset=${offset}`);
    if (!r.ok) break;
    const j = await r.json();
    const batch = j?.matches || j || [];
    if (!batch.length) break;
    matches.push(...batch);
    if (batch.length < PAGE) break;
  }
  return matches;
}
async function getCompetitionMatchesWinner(compId){
  const matches = await listCompetitionMatches(compId);
  if (!matches.length) return null;
  const lc = s => String(s||"").toLowerCase();
  let final = matches.find(m => /\bdivision\s*1\b|\bdiv\s*1\b|\bd1\b/.test(lc(m.name))) ||
              matches.reduce((best,cur)=>{
                const bp = best?.position ?? best?.number ?? -1;
                const cp = cur?.position ?? cur?.number ?? -1;
                return cp > bp ? cur : best;
              }, matches[0]);
  if (!final?.id) return null;

  const res = await fetchMeet(`${MEET}/api/matches/${final.id}/results?length=255&offset=0`);
  dlog(`[winner] comp match results http=${res.status} mid=${final.id}`);
  if (!res.ok) return null;
  const J = await res.json();
  const arr = J?.results || J?.participants || J || [];
  if (!Array.isArray(arr) || !arr.length) return null;

  arr.sort((a,b)=>{
    const ar = a.rank ?? a.position ?? Infinity;
    const br = b.rank ?? b.position ?? Infinity;
    if (ar !== br) return ar - br;
    const ap = typeof a.points === "number" ? -a.points : 0;
    const bp = typeof b.points === "number" ? -b.points : 0;
    return ap - bp;
  });

  const top = arr[0];
  const { accountId, displayName } = extractWinnerFields(top);
  return (accountId||displayName) ? { accountId: accountId||null, displayName: displayName||null, via: "compMatches" } : null;
}

/* -------------------------- finished gating & helpers ----------------------- */
const GRACE_MS=20*60*1000; // 20-min grace

async function getCompetitionDetail(compId){
  const r=await fetchMeet(`${MEET}/api/competitions/${compId}`);
  if(!r.ok) throw new Error(`competition detail failed: ${r.status}`);
  return r.json();
}
function isEditionFinishedLike(detail,nowMs=Date.now()){
  const status=String(detail?.status||detail?.state||"").toLowerCase();
  if(["finished","completed","closed","ended"].includes(status)) return true;
  const endMs=toMs(detail?.endDate??detail?.endTime??detail?.plannedEndDate??detail?.dateEnd??null);
  if(Number.isFinite(endMs)) return nowMs>=endMs+GRACE_MS;
  return false;
}
function extractEditionId(detail){
  return detail?.currentEditionId??detail?.editionId??detail?.edition?.id??(Array.isArray(detail?.editions)?detail.editions.at(-1)?.id:null)??null;
}

/* -------------------------------- main updater ------------------------------ */
async function updateCotdCurrentMonth(){
  const now=new Date(), y=now.getUTCFullYear(), m1=now.getUTCMonth()+1, mKey=monthKey(y,m1);
  const monthPath=path.join(COTD_DIR,`${mKey}.json`);
  const monthData=await loadJson(monthPath,{ month:mKey, days:{} });
  const toHydrate=new Set();

  for(const d of daysOfMonth(y,m1)){
    if(!clampToToday(y,m1,d)) break;
    const dk=dateKey(y,m1,d);
    const isToday = dk === dateKey(y,m1,now.getUTCDate());

    // ensure shape
    if(!monthData.days[dk]) monthData.days[dk]={ date:dk, cotd:{ winnerAccountId:null, winnerDisplayName:null } };

    const cur=monthData.days[dk]?.cotd;
    if(cur?.winnerAccountId && !cur?.winnerDisplayName){ toHydrate.add(cur.winnerAccountId); continue; }
    if(cur?.winnerAccountId || cur?.winnerDisplayName) continue; // already done

    try{
      let comp=await findCotdCompetitionByDate(y,m1,d);

      // TODAY fallback: authoritative current endpoint
      if(!comp && isToday){
        const current = await getCurrentCotd();
        if (current?.competition?.id) comp = { id: current.competition.id, name: current.competition.name };
      }

      if(!comp){ console.log(`[COTD] ${dk} no competition found`); continue; }
      const cid=comp.id||comp.liveId||comp.uid;
      if(DEBUG) console.log(`[COTD] ${dk} comp id=${cid} name="${comp.name}"`);

      // gate on finished/grace
      let detail=null;
      try{ detail=await getCompetitionDetail(cid); }
      catch(e){ dlog(`[COTD] ${dk} detail fetch failed: ${e.message}`); continue; }
      if(!isEditionFinishedLike(detail)){ dlog(`[COTD] ${dk} pending — edition not finished/grace yet`); continue; }

      // A: competition leaderboard (fast path)
      let winner=await getWinnerFromCompetitionLeaderboard(cid);

      // B: D1 results (rounds)
      if(!winner){
        dlog(`[winner] comp LB empty, trying D1 for comp ${cid}`);
        winner=await getD1WinnerForCompetition(cid);
      }

      // C: edition-level fallbacks
      if(!winner){
        dlog(`[winner] D1 empty, trying edition fallbacks for comp ${cid}`);
        winner=await getEditionWinnerFallback(cid);
      }

      // D: competition matches (direct) — some comps expose this even when rounds 401
      if(!winner){
        dlog(`[winner] edition fallbacks empty, trying comp matches for comp ${cid}`);
        winner=await getCompetitionMatchesWinner(cid);
      }

      if(!winner){
        dlog(`[COTD] ${dk} winner still computing — will retry next run`);
        continue;
      }

      monthData.days[dk]={ date:dk, cotd:{ winnerAccountId:winner.accountId||null, winnerDisplayName:winner.displayName||null } };
      if(winner.accountId) toHydrate.add(winner.accountId);
      console.log(`[COTD] ${dk} competition=${cid} winner=${winner.displayName||winner.accountId||"(unknown)"} via=${winner.via||"?"}`);
    }catch(e){
      console.log(`[COTD] ${dk} error: ${e.message}`);
    }
  }

  if(toHydrate.size){
    const map=await hydrateDisplayNames([...toHydrate]);
    for(const dk of Object.keys(monthData.days)){
      const c=monthData.days[dk]?.cotd;
      if(c?.winnerAccountId && !c.winnerDisplayName) c.winnerDisplayName=map[c.winnerAccountId]??null;
    }
  }

  await ensureDir(COTD_DIR);
  await writeJson(monthPath,monthData);
  await rebuildMonthIndex(COTD_DIR);

  const todayKey=dateKey(y,m1,now.getUTCDate());
  const todayRec=monthData.days[todayKey]||{ date:todayKey, cotd:{ winnerAccountId:null, winnerDisplayName:null } };
  await writeJson(COTD_LATEST,{ generatedAt:new Date().toISOString(), ...todayRec });
}

/* ----------------------------------- main ----------------------------------- */
async function main(){
  await ensureDir(TOTD_DIR);
  await ensureDir(COTD_DIR);
  await writeTotdMonth(0);          // tm.io for TOTD (kept)
  await updateCotdCurrentMonth();   // Meet + Core for names, with deeper fallbacks
  console.log("[DONE] TOTD + COTD updated.");
}
main().catch(err=>{ console.error(err); process.exit(1); });
