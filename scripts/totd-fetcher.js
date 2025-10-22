// scripts/totd-fetcher.js — TOTD + auto downloadUrl (preserves manual URLs)
// Node 18+ (global fetch). No secrets needed.

import { mkdir, writeFile, readFile, access, readdir } from "node:fs/promises";
import { constants as FS } from "node:fs";
import path from "node:path";

/* ----------------------------- config/constants ---------------------------- */
const PUBLIC_DIR  = process.env.PUBLIC_DIR || ".";
const TOTD_DIR    = `${PUBLIC_DIR.replace(/\/+$/,"")}/data/totd`;
const TOTD_LATEST = `${PUBLIC_DIR.replace(/\/+$/,"")}/totd.json`;
const TMIO        = "https://trackmania.io";
const USER_AGENT  = process.env.USER_AGENT || "tm-totd/1.0 (github action)";

const DEBUG = process.env.DEBUG === "1";
const dlog  = (...a)=>{ if (DEBUG) console.log("[TOTD]", ...a); };

/* -------------------------------- fs helpers ------------------------------- */
const ensureDir = (p)=>mkdir(p,{recursive:true});
const exists = async(p)=>{ try{ await access(p,FS.F_OK); return true; } catch { return false; } };
const loadJson = async(p,f)=>(await exists(p))?JSON.parse(await readFile(p,"utf8")):f;
const writeJson=(p,obj)=>writeFile(p,JSON.stringify(obj,null,2),"utf8");

/* --------------------------------- utils ----------------------------------- */
const pad2=(n)=>String(n).padStart(2,"0");
const monthKey=(y,m1)=>`${y}-${pad2(m1)}`;
const dateKey=(y,m1,d)=>`${y}-${pad2(m1)}-${pad2(d)}`;
function stripTmFormatting(input){
  if(!input || typeof input!=="string") return input;
  const D="\uFFF0";
  let s=input.replace(/\$\$/g,D);
  s=s.replace(/\$[0-9a-fA-F]{1,3}|\$[a-zA-Z]|\$[<>\[\]\(\)]/g,"");
  return s.replace(new RegExp(D,"g"),"$");
}
function tmioDayNumber(dayObj,idx){ return dayObj?.day??dayObj?.dayIndex??dayObj?.monthDay??dayObj?.dayInMonth??(idx+1); }

async function sleep(ms){ return new Promise(r=>setTimeout(r,ms)); }
async function fetchRetry(url,opts={},retries=5,baseDelay=500){
  let lastErr;
  for(let i=0;i<=retries;i++){
    try{
      const r=await fetch(url,{ ...opts, headers:{ "User-Agent":USER_AGENT, ...(opts.headers||{}) }});
      if(r.status===429 || (r.status>=500 && r.status<=599)){
        const wait=Math.min(baseDelay*Math.pow(2,i),8000);
        if (DEBUG) dlog(`retry ${i} ${r.status} ${url} wait=${wait}ms`);
        await sleep(wait);
        continue;
      }
      return r;
    }catch(e){
      lastErr=e;
      const wait=Math.min(baseDelay*Math.pow(2,i),8000);
      if (DEBUG) dlog(`retry ${i} err ${e?.message||e} wait=${wait}ms`);
      await sleep(wait);
    }
  }
  throw lastErr || new Error(`fetch failed for ${url}`);
}

/* ------------------------------ tm.io helpers ------------------------------ */
async function fetchTmioMonth(index=0){
  const r=await fetchRetry(`${TMIO}/api/totd/${index}`);
  if(!r.ok) throw new Error(`tm.io totd[${index}] failed: ${r.status}`);
  return r.json();
}
function tmioMonthYear(resp){
  const y=resp?.month?.year??new Date().getUTCFullYear();
  const m1=(resp?.month?.month??new Date().getUTCMonth())+1;
  return { y,m1 };
}
async function fetchMapDownload(mapUid){
  if (!mapUid) return null;
  const r = await fetchRetry(`${TMIO}/api/map/${encodeURIComponent(mapUid)}`);
  if (!r.ok) { dlog("map detail failed", mapUid, r.status); return null; }
  const j = await r.json();
  // The field from tm.io that points to TMX download is usually "file"
  return j?.file || j?.download || null;
}

/* ------------------------------ month writing ------------------------------ */
async function rebuildMonthIndex(dir){
  await ensureDir(dir);
  const items=await readdir(dir,{withFileTypes:true});
  const months=items
    .filter(e=>e.isFile()&&e.name.endsWith(".json")&&e.name!=="months.json"&&!e.name.startsWith("_"))
    .map(e=>e.name.replace(/\.json$/,""))
    .sort().reverse();
  await writeJson(path.join(dir,"months.json"),{ months });
}

function baseDayRecord(y,m1,entry,idx){
  const m=entry.map||entry;
  const uid=m.mapUid??entry.mapUid??null;
  let name=m.name??m.mapName??entry.name??"(unknown map)";
  let authorDisplayName=m.authorPlayer?.name??m.authorplayer?.name??m.authorName??m.author??entry.authorPlayer?.name??entry.authorplayer?.name??"(unknown)";
  const thumb=m.thumbnail??m.thumbnailUrl??entry.thumbnail??entry.thumbnailUrl??"";
  const authorAccountId=m.authorPlayer?.accountId??m.authorplayer?.accountid??entry.authorPlayer?.accountId??entry.authorplayer?.accountid??null;
  const d=tmioDayNumber(entry,idx);
  name=stripTmFormatting(name); authorDisplayName=stripTmFormatting(authorDisplayName);
  return {
    date: dateKey(y,m1,d),
    map: { uid, name, authorAccountId, authorDisplayName, thumbnailUrl: thumb, downloadUrl: null }
  };
}

async function writeTotdMonth(index=0){
  // 0) load remote list
  const j=await fetchTmioMonth(index);
  const {y,m1}=tmioMonthYear(j);
  const mKey=monthKey(y,m1);

  // 1) load existing month file (so manual downloadUrl entries are preserved)
  const monthPath = path.join(TOTD_DIR,`${mKey}.json`);
  const prev = await loadJson(monthPath, { month:mKey, days:{} });
  const prevDays = prev?.days || {};

  // 2) normalize remote -> day records
  const daysArr = (Array.isArray(j.days)?j.days:[]).map((entry,i)=>baseDayRecord(y,m1,entry,i));

  // 3) for each day:
  //    - keep manual downloadUrl if it already exists
  //    - otherwise fetch from tm.io /api/map/{uid}
  for (const rec of daysArr){
    const prevDl = prevDays[rec.date]?.map?.downloadUrl || null;
    if (prevDl) {
      rec.map.downloadUrl = prevDl;       // preserve manual/old link
      continue;
    }
    if (rec.map.uid){
      rec.map.downloadUrl = await fetchMapDownload(rec.map.uid);
      await sleep(80); // be nice to tm.io
    }
  }

  // 4) write month file
  const daysOut={};
  for (const rec of daysArr){ daysOut[rec.date]=rec; }

  await ensureDir(TOTD_DIR);
  await writeJson(monthPath,{ month:mKey, days:daysOut });
  await rebuildMonthIndex(TOTD_DIR);

  // 5) write latest snapshot
  const keys=Object.keys(daysOut).sort();
  const latestKey=keys[keys.length-1]||null;
  if(latestKey){
    const latest=daysOut[latestKey];
    await writeJson(TOTD_LATEST,{ generatedAt:new Date().toISOString(), ...latest });
    dlog("latest:", latest.date, latest.map?.name, latest.map?.downloadUrl ? "[dl]" : "");
  }else{
    dlog("no days found for", mKey);
  }
}

/* ----------------------------------- main ---------------------------------- */
async function main(){
  await ensureDir(TOTD_DIR);
  await writeTotdMonth(0); // current month (index 0)
  console.log("[DONE] TOTD updated with download URLs (manual URLs preserved).");
}
main().catch(err=>{ console.error(err); process.exit(1); });
