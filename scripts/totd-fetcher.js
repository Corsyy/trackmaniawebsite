// scripts/totd-fetcher.js — TOTD + TMX medal times & difficulty (keeps manual downloadUrl)
// Node 18+ (global fetch).

import { mkdir, writeFile, readFile, access, readdir } from "node:fs/promises";
import { constants as FS } from "node:fs";
import path from "node:path";

/* ----------------------------- config/constants ---------------------------- */
const PUBLIC_DIR  = process.env.PUBLIC_DIR || ".";
const TOTD_DIR    = `${PUBLIC_DIR.replace(/\/+$/,"")}/data/totd`;
const TOTD_LATEST = `${PUBLIC_DIR.replace(/\/+$/,"")}/totd.json`;
const TMIO        = "https://trackmania.io";
const TMX_API     = "https://trackmania.exchange/api"; // base for TMX API
const TMX_DL_BASE = "https://trackmania.exchange/maps/download";
const USER_AGENT  = process.env.USER_AGENT || "tm-totd/1.1 (github action)";

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

/* ------------------------------ TMX helpers --------------------------------
   We try TMX first: UID -> TMX map info (TrackID, medal times, difficulty, etc).
   If TMX lacks the map, we fall back to trackmania.io for a download.
-----------------------------------------------------------------------------*/
async function fetchTmxInfoByUid(uid){
  if (!uid) return null;
  const url = `${TMX_API}/maps/get_map_info/uid/${encodeURIComponent(uid)}`;
  const r = await fetchRetry(url);
  if (!r.ok) { dlog("TMX uid lookup failed", uid, r.status); return null; }
  try {
    const j = await r.json();
    if (!j || typeof j !== "object") return null;
    if (j.TrackUID && j.TrackUID !== uid) return null;
    return j;
  } catch { return null; }
}

async function fetchTmxInfoById(trackId){
  if (!trackId) return null;
  const url = `${TMX_API}/maps/get_map_info/id/${encodeURIComponent(trackId)}`;
  const r = await fetchRetry(url);
  if (!r.ok) return null;
  try {
    const j = await r.json();
    if (!j || typeof j !== "object") return null;
    if (!j.TrackID || String(j.TrackID) !== String(trackId)) return null;
    return j;
  } catch { return null; }
}

function tmxDownloadUrl(trackId, shortName){
  const base = `${TMX_DL_BASE}/${encodeURIComponent(trackId)}`;
  return shortName ? `${base}?shortName=${encodeURIComponent(shortName)}` : base;
}

/* --------------------------- download & medals ----------------------------- */
function pickMedalFields(tmx){
  // TMX returns ms times; Difficulty is an integer-ish category (0–5+).
  const toInt = v => (v==null ? null : Number(v));
  const diff  = v => (v==null ? null : Number(v));
  return {
    authorTime : toInt(tmx?.AuthorTime),
    goldTime   : toInt(tmx?.GoldTime),
    silverTime : toInt(tmx?.SilverTime),
    bronzeTime : toInt(tmx?.BronzeTime),
    difficulty : diff(tmx?.Difficulty)
  };
}

async function fetchMapDetails(mapUid){
  if (!mapUid) return { downloadUrl:null, medals:null };

  // 1) Try TMX (prefer — gives us medals + difficulty + often a valid download)
  try {
    const tmx = await fetchTmxInfoByUid(mapUid);
    if (tmx && tmx.TrackID) {
      let shortName = tmx.ShortName || tmx.shortName || null;

      if ((tmx.Unlisted === true || tmx.Unlisted === 1) && !shortName) {
        const tmxById = await fetchTmxInfoById(tmx.TrackID);
        shortName = tmxById?.ShortName || tmxById?.shortName || null;
      }

      const downloadable = (tmx.Downloadable ?? true);
      const downloadUrl = downloadable ? tmxDownloadUrl(tmx.TrackID, shortName) : null;
      const medals = pickMedalFields(tmx);

      return { downloadUrl, medals };
    }
  } catch (e) {
    dlog("TMX resolver err", mapUid, e?.message || e);
  }

  // 2) Fallback to trackmania.io for a file URL (no medals here)
  try {
    const r = await fetchRetry(`${TMIO}/api/map/${encodeURIComponent(mapUid)}`);
    if (!r.ok) { dlog("tm.io map detail failed", mapUid, r.status); return { downloadUrl:null, medals:null }; }
    const j = await r.json();
    return { downloadUrl: j?.file || j?.download || null, medals:null };
  } catch (e) {
    dlog("tm.io resolver err", mapUid, e?.message || e);
    return { downloadUrl:null, medals:null };
  }
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
    map: {
      uid, name, authorAccountId, authorDisplayName, thumbnailUrl: thumb,
      downloadUrl: null,
      authorTime:null, goldTime:null, silverTime:null, bronzeTime:null, difficulty:null
    }
  };
}

async function writeTotdMonth(index=0){
  // 0) load remote list
  const j=await fetchTmioMonth(index);
  const {y,m1}=tmioMonthYear(j);
  const mKey=monthKey(y,m1);

  // 1) load existing month file (so manual overrides are preserved)
  const monthPath = path.join(TOTD_DIR,`${mKey}.json`);
  const prev = await loadJson(monthPath, { month:mKey, days:{} });
  const prevDays = prev?.days || {};

  // 2) normalize remote -> day records
  const daysArr = (Array.isArray(j.days)?j.days:[]).map((entry,i)=>baseDayRecord(y,m1,entry,i));

  // 3) hydrate each day with TMX medals/difficulty + download, preserving any manual downloadUrl
  for (const rec of daysArr){
    const prevRec = prevDays[rec.date]?.map || {};
    // keep any manual/previous link
    if (prevRec.downloadUrl) {
      rec.map.downloadUrl = prevRec.downloadUrl;
    }
    // only fetch if we have a UID and no preserved link/medals yet
    if (rec.map.uid && (!rec.map.downloadUrl || prevRec.authorTime==null)){
      const { downloadUrl, medals } = await fetchMapDetails(rec.map.uid);
      if (!rec.map.downloadUrl) rec.map.downloadUrl = downloadUrl || null;
      if (medals){
        rec.map.authorTime = medals.authorTime;
        rec.map.goldTime   = medals.goldTime;
        rec.map.silverTime = medals.silverTime;
        rec.map.bronzeTime = medals.bronzeTime;
        rec.map.difficulty = medals.difficulty;
      }
      await sleep(120); // be nice to public APIs
    }else{
      // carry forward previously stored medals/difficulty if present
      rec.map.authorTime = prevRec.authorTime ?? rec.map.authorTime;
      rec.map.goldTime   = prevRec.goldTime   ?? rec.map.goldTime;
      rec.map.silverTime = prevRec.silverTime ?? rec.map.silverTime;
      rec.map.bronzeTime = prevRec.bronzeTime ?? rec.map.bronzeTime;
      rec.map.difficulty = prevRec.difficulty ?? rec.map.difficulty;
    }
  }

  // 4) write month file
  const daysOut={}; for (const rec of daysArr){ daysOut[rec.date]=rec; }
  await ensureDir(TOTD_DIR);
  await writeJson(monthPath,{ month:mKey, days:daysOut });
  await rebuildMonthIndex(TOTD_DIR);

  // 5) write latest snapshot
  const keys=Object.keys(daysOut).sort();
  const latestKey=keys[keys.length-1]||null;
  if(latestKey){
    const latest=daysOut[latestKey];
    await writeJson(TOTD_LATEST,{ generatedAt:new Date().toISOString(), ...latest });
    dlog("latest:", latest.date, latest.map?.name, latest.map?.downloadUrl ? "[dl]" : "", "medals?",
         latest.map?.authorTime!=null);
  }else{
    dlog("no days found for", mKey);
  }
}

/* ----------------------------------- main ---------------------------------- */
async function main(){
  await ensureDir(TOTD_DIR);
  await writeTotdMonth(0); // current month (index 0)
  console.log("[DONE] TOTD updated with TMX medal times + difficulty.");
}
main().catch(err=>{ console.error(err); process.exit(1); });
