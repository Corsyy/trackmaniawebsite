// scripts/cotd-fetcher.js (hardened)
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

const NADEO_REFRESH_TOKEN = process.env.NADEO_REFRESH_TOKEN || "";
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
if(!NADEO_REFRESH_TOKEN){
  console.error("ERROR: Missing NADEO_REFRESH_TOKEN env.");
  process.exit(1);
}
const tokenCache=new Map(); // audience -> { token, expAt }

async function refreshForAudience(audience){
  const r=await fetch(`${CORE}/v2/authentication/token/refresh`,{
    method:"POST",
    headers:{ "Content-Type":"application/json", Authorization:`nadeo_v1 t=${NADEO_REFRESH_TOKEN}` },
    body:JSON.stringify({ audience })
  });
  if(!r.ok){ const txt=await r.text().catch(()=> ""); throw new Error(`refresh(${audience}) failed: ${r.status} ${txt}`); }
  const j=await r.json();
  const token=j.accessToken;
  const expMs=(j.expiresIn?j.expiresIn*1000:9*60*1000);
  tokenCache.set(audience,{ token, expAt: Date.now()+expMs });
  return token;
}
async function getToken(audience){
  const entry=tokenCache.get(audience);
  if(entry && Date.now()<entry.expAt-10000) return entry.token;
  return refreshForAudience(audience);
}
async function authedFetch(url,{audience,init={},retryOnAuth=true}={}){
  let token=await getToken(audience);
  let r=await fetch(url,{...init, headers:{ ...(init.headers||{}), Authorization:`nadeo_v1 t=${token}` }});
  if(retryOnAuth && (r.status===401||r.status===403)){
    token=await refreshForAudience(audience);
    r=await fetch(url,{...init, headers:{ ...(init.headers||{}), Authorization:`nadeo_v1 t=${token}` }});
  }
  return r;
}
// NOTE: Meet/Live need NadeoLiveServices; Core needs NadeoServices.
const fetchMeet=(url,init={})=>authedFetch(url,{ audience:"NadeoLiveServices", init });
const fetchCore=(url,init={})=>authedFetch(url,{ audience:"NadeoServices", init }); // <-- fixed audience

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

/* ---------- path A: competition leaderboard (first place = winner) ---------- */
async function getWinnerFromCompetitionLeaderboard(compId){
  try{
    const url = `${MEET}/api/competitions/${compId}/leaderboard?length=1&offset=0`;
    const r = await fetchMeet(url);
    if (DEBUG) dlog(`[winner] comp LB http=${r.status} id=${compId}`);
    if (r.status===204) return null; // no content
    if (!r.ok) return null;

    // Content may be blank => guard before json()
    const raw = await r.text();
    if (!raw) return null;
    let j; try { j = JSON.parse(raw); } catch { return null; }

    const pickFirst = (arr)=> {
      if (!Array.isArray(arr) || !arr.length) return null;
      const { accountId, displayName } = extractWinnerFields(arr[0]);
      return (accountId||displayName) ? { displayName: displayName||null, accountId: accountId||null, via:"competitionLB" } : null;
    };

    let winner = Array.isArray(j) ? pickFirst(j) : null;
    if (!winner && Array.isArray(j.leaderboard)) winner = pickFirst(j.leaderboard);
    if (!winner && Array.isArray(j.top))         winner = pickFirst(j.top);
    if (!winner && Array.isArray(j.results))     winner = pickFirst(j.results);
    if (!winner && Array.isArray(j.ranks))       winner = pickFirst(j.ranks);
    if (!winner && Array.isArray(j.players))     winner = pickFirst(j.players);
    if (!winner && Array.isArray(j.items))       winner = pickFirst(j.items);

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
// REPLACE your entire getD1WinnerForCompetition() with this version:
async function getD1WinnerForCompetition(compId){
  if(!compId) return null;

  // 1) fetch all rounds
  const roundsRes = await fetchMeet(`${MEET}/api/competitions/${compId}/rounds`);
  if (DEBUG) dlog(`[winner] rounds http=${roundsRes.status} id=${compId}`);
  if(!roundsRes.ok) return null;

  const rounds = await roundsRes.json();
  if(!Array.isArray(rounds) || !rounds.length) return null;

  // 2) fetch matches for ALL rounds (not just the one named "final")
  const PAGE = 100;
  const allMatches = [];
  for (const r of rounds) {
    for (let offset = 0; offset < 2000; offset += PAGE) {
      const res = await fetchMeet(`${MEET}/api/rounds/${r.id}/matches?length=${PAGE}&offset=${offset}`);
      if (!res.ok) break;
      const j = await res.json();
      const batch = j?.matches || j || [];
      if (!batch.length) break;
      // tag each match with its round for possible tie-breaks
      for (const m of batch) allMatches.push({ ...m, _round: r });
      if (batch.length < PAGE) break;
    }
  }
  if (DEBUG) dlog(`[winner] total matches fetched=${allMatches.length} comp=${compId}`);
  if (!allMatches.length) return null;

  // 3) pick "Division 1" match robustly
  const lc = (s)=>String(s||"").toLowerCase();
  let d1 =
    allMatches.find(m => /\bdivision\s*1\b|\bdiv\s*1\b|\bd1\b/.test(lc(m.name))) ||
    allMatches.find(m => (m.division ?? m.Division ?? m.divisionNumber) === 1);

  // Heuristics if the above didn’t hit:
  if (!d1) {
    // Prefer matches from the last round by position, then smallest match position/number
    const lastRound = rounds.reduce((a,b)=>((a?.position??-1)>(b?.position??-1)?a:b), rounds[0]);
    const inLast = allMatches.filter(m => m._round?.id === lastRound.id);
    const pool = inLast.length ? inLast : allMatches;
    d1 = pool.reduce((best,cur) => {
      const bp = best?.position ?? best?.number ?? Number.POSITIVE_INFINITY;
      const cp =  cur?.position ??  cur?.number ?? Number.POSITIVE_INFINITY;
      return cp < bp ? cur : best;
    }, pool[0]);
  }
  if (!d1?.id) return null;

  // 4) winner from the D1 match results
  const resultsRes = await fetchMeet(`${MEET}/api/matches/${d1.id}/results?length=255&offset=0`);
  if (DEBUG) dlog(`[winner] results http=${resultsRes.status} match=${d1.id} name="${d1.name}"`);
  if (!resultsRes.ok) return null;

  const raw = await resultsRes.text();
  if (!raw) return null;
  let resultsJ; try { resultsJ = JSON.parse(raw); } catch { return null; }
  const arr = resultsJ?.results || resultsJ?.participants || resultsJ || [];
  if (!Array.isArray(arr) || !arr.length) return null;

  arr.sort((a,b)=>{
    const ar = a.rank ?? a.position ?? Infinity, br = b.rank ?? b.position ?? Infinity;
    if (ar !== br) return ar - br;
    const ap = typeof a.points === "number" ? -a.points : 0;
    const bp = typeof b.points === "number" ? -b.points : 0;
    return ap - bp;
  });

  const top = arr[0];
  const { accountId, displayName } = extractWinnerFields(top);
  return { accountId: accountId || null, displayName: displayName || null, rank: top.rank ?? top.position ?? 1, via: "d1-all-rounds" };
}

/* --------------------- display-name hydration (Core) ------------------------ */
const NAMES_CACHE_PATH=path.join(COTD_DIR,"_names-cache.json");
async function loadNamesCache(){ return await loadJson(NAMES_CACHE_PATH,{}); }
async function saveNamesCache(cache){ await ensureDir(COTD_DIR); await writeJson(NAMES_CACHE_PATH,cache); }
async function fetchDisplayNamesBulk(ids){
  if(!ids?.length) return {};
  const uniq=[...new Set(ids)].filter(Boolean);
  const chunks=[]; for(let i=0;i<uniq.length;i+=100) chunks.push(uniq.slice(i,i+100));
  const out={};
  for(const chunk of chunks){
    const url=new URL(`${CORE}/accounts/displayNames`);
    url.searchParams.set("accountIdList", chunk.join(","));
    const r=await fetchCore(url.toString());
    if(!r.ok) throw new Error(`displayNames failed: ${r.status}`);
    const arr=await r.json();
    for(const it of arr||[]){ if(it?.accountId) out[it.accountId]=it.displayName||null; }
  }
  return out;
}
async function hydrateDisplayNames(ids){
  const cache=await loadNamesCache();
  const missing=ids.filter(id=>cache[id]===undefined);
  if(missing.length){
    const fetched=await fetchDisplayNamesBulk(missing);
    for(const id of missing) cache[id]=fetched[id]??null;
    await saveNamesCache(cache);
  }
  const map={}; for(const id of ids) map[id]=cache[id]??null;
  return map;
}

/* ----------------------------- month aggregation ---------------------------- */
async function upsertMonth(dir,mKey,dayKey,record){
  await ensureDir(dir);
  const p=path.join(dir,`${mKey}.json`);
  const data=await loadJson(p,{ month:mKey, days:{} });
  data.days[dayKey]=record;
  await writeJson(p,data);
  await rebuildMonthIndex(dir);
}

/* -------------------------- finished gating & helpers ----------------------- */
const GRACE_MS=6*60*1000; // 6 min grace
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

    // ensure shape
    if(!monthData.days[dk]) monthData.days[dk]={ date:dk, cotd:{ winnerAccountId:null, winnerDisplayName:null } };

    const cur=monthData.days[dk]?.cotd;
    if(cur?.winnerAccountId && !cur?.winnerDisplayName){ toHydrate.add(cur.winnerAccountId); continue; }
    if(cur?.winnerAccountId || cur?.winnerDisplayName) continue; // already done

    try{
      const comp=await findCotdCompetitionByDate(y,m1,d);
      if(!comp){ console.log(`[COTD] ${dk} no competition found`); continue; }
      const cid=comp.id||comp.liveId||comp.uid;
      if(DEBUG) console.log(`[COTD] ${dk} comp id=${cid} name="${comp.name}"`);

      // gate on finished/grace
      let detail=null;
      try{ detail=await getCompetitionDetail(cid); }
      catch(e){ dlog(`[COTD] ${dk} detail fetch failed: ${e.message}`); continue; }
      if(!isEditionFinishedLike(detail)){ dlog(`[COTD] ${dk} pending — edition not finished/grace yet`); continue; }

      // try A: competition leaderboard (fast path)
      let winner=await getWinnerFromCompetitionLeaderboard(cid);

      // try B: D1 results (robust path)
      if(!winner){
        dlog(`[winner] comp LB empty, trying D1 for comp ${cid}`);
        winner=await getD1WinnerForCompetition(cid);
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
  await writeTotdMonth(0);
  await updateCotdCurrentMonth();
  console.log("[DONE] TOTD + COTD updated.");
}
main().catch(err=>{ console.error(err); process.exit(1); });
