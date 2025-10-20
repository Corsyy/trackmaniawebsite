import { writeFile, mkdir } from "fs/promises";
import path from "path";

const MONTH = (process.argv[2] || new Date().toISOString().slice(0,7)); // "YYYY-MM"
const OUTDIR = path.join("data", "totd");
const OUTFILE = path.join(OUTDIR, `${MONTH}.json`);

const nadeoToken = process.env.NADEO_TOKEN || ""; // Live API (required for reliable month feed)
const tmApiToken = process.env.TM_API_TOKEN || ""; // Optional: display-names

// --- helpers ---------------------------------------------------------------

function cleanTM(str = "") {
  return String(str).replace(/\$[0-9a-fA-F]{3}|\$[a-zA-Z]|\$[0-9a-fA-F]/g, "").trim();
}
function looksLikeUUID(s = "") {
  return /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i.test(s);
}
async function j(url, opt={}) {
  const r = await fetch(url, opt);
  if (!r.ok) throw new Error(`${r.status} ${r.statusText} @ ${url}`);
  return r.json();
}

// Try both documented Live endpoints in case one alias changes
async function fetchMonthFromLive(offset) {
  const headers = { Authorization: nadeoToken };
  // Primary (Openplanet docs): /campaigns/totds
  try {
    const url = `https://live-services.trackmania.nadeo.live/api/token/campaigns/totds?offset=${offset}&length=1`;
    const data = await j(url, { headers });
    return data?.monthList?.[0] || data?.monthList || null;
  } catch (_) {}
  // Fallback (older alias): /campaign/month
  const url2 = `https://live-services.trackmania.nadeo.live/api/token/campaign/month?offset=${offset}&length=1`;
  const data2 = await j(url2, { headers });
  return data2?.monthList?.[0] || data2?.monthList || null;
}

// Get map info (thumbnail + author accountId)
async function getMapInfos(uids) {
  const headers = { Authorization: nadeoToken };
  const out = {};
  for (let i = 0; i < uids.length; i += 20) {
    const chunk = uids.slice(i, i + 20);
    await Promise.all(chunk.map(async uid => {
      try {
        const info = await j(`https://live-services.trackmania.nadeo.live/api/token/map/${encodeURIComponent(uid)}`, { headers });
        out[uid] = info || {};
      } catch (e) {
        // ignore; we’ll try tm.io enrichment later
      }
    }));
  }
  return out;
}

// Optional: convert accountIds -> display names (TM Public API)
async function idToDisplayNames(accountIds) {
  if (!tmApiToken || !accountIds.length) return {};
  const names = {};
  for (let i = 0; i < accountIds.length; i += 50) {
    const qs = accountIds.slice(i, i + 50).map(id => `accountId[]=${encodeURIComponent(id)}`).join("&");
    const url = `https://api.trackmania.com/api/display-names?${qs}`;
    try {
      const obj = await j(url, { headers: { Authorization: tmApiToken } });
      Object.assign(names, obj);
    } catch (_) {}
  }
  return names;
}

// Public fallback enrichment via trackmania.io (no auth)
async function enrichViaTmio(uid) {
  try {
    const m = await j(`https://trackmania.io/api/map/${encodeURIComponent(uid)}`, {
      headers: { "User-Agent": "trackmaniaevents.com (cotd-fetcher)" }
    });
    const authorName = m?.authorplayer?.name || m?.authorname || m?.author || "";
    const thumbnail = m?.thumbnail || m?.thumbnailUrl || m?.thumbnailURL || "";
    return {
      authorName: authorName ? cleanTM(authorName) : "",
      thumbnail: thumbnail || ""
    };
  } catch (_) {
    return { authorName: "", thumbnail: "" };
  }
}

// Compute month offset from current UTC month
function monthOffset(targetYYYYMM) {
  const [Y, M] = targetYYYYMM.split("-").map(Number);
  const now = new Date();
  const diff = (now.getUTCFullYear() - Y) * 12 + (now.getUTCMonth() + 1 - M);
  return diff; // how many months back from current
}

// --- main ------------------------------------------------------------------

async function main() {
  if (!nadeoToken) {
    console.error("❌ Missing NADEO_TOKEN. This script uses the official Live API to get months reliably.");
    process.exit(1);
  }

  const offset = monthOffset(MONTH);
  const monthData = await fetchMonthFromLive(offset);
  if (!monthData || !monthData.days) throw new Error(`Month not found for ${MONTH}`);

  const yyyy = monthData.year;
  const mm = String(monthData.month).padStart(2, "0");

  // Sort and map days → uids
  const days = (monthData.days || []).slice().sort((a, b) => (a.day ?? a.monthDay) - (b.day ?? b.monthDay));
  const uids = [...new Set(days.map(d => d.mapUid).filter(Boolean))];

  // Live map info first (best source for thumbnail & author accountId)
  const infoByUid = await getMapInfos(uids);
  const authorIds = [...new Set(Object.values(infoByUid).map(x => x?.author).filter(Boolean))];
  const nameById = await idToDisplayNames(authorIds);

  const out = [];
  for (const d of days) {
    const dd = String(d.monthDay ?? d.day).padStart(2, "0");
    const date = `${yyyy}-${mm}-${dd}`;
    const uid = d.mapUid || "";
    const live = infoByUid[uid] || {};

    let authorName = live?.author ? (nameById[live.author] || live.author) : "";
    let thumbnail = live?.thumbnailUrl || "";

    // Fallback to tm.io if we still lack a human display name or thumbnail
    if (!thumbnail || !authorName || looksLikeUUID(authorName)) {
      const extra = await enrichViaTmio(uid);
      if (!thumbnail) thumbnail = extra.thumbnail || "";
      if ((!authorName || looksLikeUUID(authorName)) && extra.authorName) authorName = extra.authorName;
    }

    out.push({
      date,
      mapUid: uid,
      name: cleanTM(live?.name || d?.name || "Track of the Day"),
      author: authorName ? cleanTM(authorName) : "Unknown",
      thumbnail: thumbnail || "",
      image: thumbnail || "",
      start: d.startTimestamp ?? null,
      end: d.endTimestamp ?? null,
      winners: [] // ← hook for later (COTD winners integration)
    });
  }

  await mkdir(OUTDIR, { recursive: true });
  await writeFile(OUTFILE, JSON.stringify({ month: MONTH, updated: new Date().toISOString(), tracks: out }, null, 2));
  console.log(`Wrote ${OUTFILE} with ${out.length} days.`);
}

main().catch(err => {
  console.error("COTD month fetch failed:", err);
  process.exit(1);
});
