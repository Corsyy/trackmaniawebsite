import { writeFile, mkdir } from "fs/promises";
import path from "path";

const MONTH = (process.argv[2] || new Date().toISOString().slice(0, 7)); // "YYYY-MM"
const OUTDIR = path.join("data", "totd");
const OUTFILE = path.join(OUTDIR, `${MONTH}.json`);

function cleanTM(str = "") {
  return String(str).replace(/\$[0-9a-fA-F]{3}|\$[a-zA-Z]|\$[0-9a-fA-F]/g, "").trim();
}
async function getJson(url, ua = "trackmaniaevents.com (cotd-fetcher)") {
  const r = await fetch(url, { headers: { "User-Agent": ua } });
  if (!r.ok) throw new Error(`${url} -> ${r.status} ${r.statusText}`);
  return r.json();
}
function ymDiffIndex(targetYM) {
  const [ty, tm] = targetYM.split("-").map(Number);
  const now = new Date();
  const cy = now.getUTCFullYear();
  const cm = now.getUTCMonth() + 1;
  return (cy - ty) * 12 + (cm - tm); // 0 = current month
}
function toISO(dateLike) {
  if (!dateLike) return null;
  if (typeof dateLike === "number") {
    const ms = dateLike < 2e10 ? dateLike * 1000 : dateLike;
    const d = new Date(ms);
    return isNaN(d) ? null : d.toISOString().slice(0, 10);
  }
  if (/^\d{4}-\d{2}-\d{2}/.test(String(dateLike))) return String(dateLike).slice(0, 10);
  const t = Date.parse(String(dateLike));
  return Number.isNaN(t) ? null : new Date(t).toISOString().slice(0, 10);
}
function isoMonth(dateISO) { return (dateISO || "").slice(0, 7); }

/* ---------- map enrichment via tm.io (author + thumbnail) ---------- */
async function enrichMap(uid) {
  if (!uid) return { author: "", thumbnail: "" };
  try {
    const m = await getJson(
      `https://trackmania.io/api/map/${encodeURIComponent(uid)}`,
      "trackmaniaevents.com (cotd-enrich)"
    );
    const author = m?.authorplayer?.name || m?.authorname || m?.author || "";
    const thumbnail = m?.thumbnail || m?.thumbnailUrl || m?.thumbnailURL || "";
    return { author: cleanTM(author || ""), thumbnail: thumbnail || "" };
  } catch {
    return { author: "", thumbnail: "" };
  }
}

/* ---------- winners (tm.io best-effort) ---------- */
async function getJsonTmio(url) {
  const r = await fetch(url, { headers: { "User-Agent": "trackmaniaevents.com (cotd-winners)" } });
  if (!r.ok) throw new Error(`${url} -> ${r.status} ${r.statusText}`);
  return r.json();
}
async function getCotdWinnersFromTmio(dateISO) {
  const tryUrls = [
    `https://trackmania.io/api/cotd/${dateISO}`,
    `https://trackmania.io/api/cotd/${dateISO}/divisions`,
  ];
  for (const url of tryUrls) {
    try {
      const data = await getJsonTmio(url);
      const divisions = data?.divisions || data;
      if (!Array.isArray(divisions)) continue;
      const winners = [];
      for (const div of divisions) {
        const top =
          div?.winner ||
          (Array.isArray(div?.results) && div.results[0]) ||
          (Array.isArray(div?.rankings) && div.rankings[0]) ||
          null;
        if (top) {
          winners.push({
            division: Number(div?.division ?? div?.index ?? winners.length + 1),
            displayName: (top.displayName || top.name || top.player || "Unknown").toString(),
            accountId: top.accountId || top.playerId || undefined,
          });
        }
      }
      if (winners.length) return winners.sort((a, b) => a.division - b.division);
    } catch { /* try next */ }
  }
  // Per-division fallback 1..60; stop after 3 misses
  let misses = 0;
  const winners = [];
  for (let div = 1; div <= 60; div++) {
    try {
      const data = await getJsonTmio(`https://trackmania.io/api/cotd/${dateISO}/divisions/${div}`);
      const top =
        data?.winner ||
        (Array.isArray(data?.results) && data.results[0]) ||
        (Array.isArray(data?.rankings) && data.rankings[0]) ||
        null;
      if (top) {
        winners.push({
          division: div,
          displayName: (top.displayName || top.name || top.player || "Unknown").toString(),
          accountId: top.accountId || top.playerId || undefined,
        });
        misses = 0;
      } else if (++misses >= 3) break;
    } catch {
      if (++misses >= 3) break;
    }
  }
  return winners;
}

/* ---------- Strategy A: month-index endpoint ---------- */
async function fetchByMonthIndex(targetYM) {
  const index = ymDiffIndex(targetYM);
  const url = `https://trackmania.io/api/totd/${index}`;
  const data = await getJson(url, "trackmaniaevents.com (cotd-month-index)");
  const days = Array.isArray(data?.days) ? data.days : [];
  if (!days.length) return { days: [], debug: { strategy: "index", url, got: 0 } };

  // Accept as-is (tm.io should already give the exact month for this index),
  // but guard by verifying the first/last items’ month.
  const normalized = [];
  for (const d of days) {
    const date =
      toISO(d?.day) || toISO(d?.date) || toISO(d?.start) || toISO(d?.end);
    if (!date) continue;
    normalized.push({ raw: d, date });
  }
  normalized.sort((a, b) => a.date.localeCompare(b.date));
  const ymFirst = isoMonth(normalized[0]?.date || "");
  const ymLast  = isoMonth(normalized[normalized.length - 1]?.date || "");
  const looksRight = (ymFirst === targetYM) || (ymLast === targetYM);

  return {
    days: looksRight ? normalized : [],
    debug: { strategy: "index", url, got: normalized.length, ymFirst, ymLast }
  };
}

/* ---------- Strategy B: page-walk (0..N) ---------- */
async function fetchByPageWalk(targetYM) {
  const collected = [];
  let page = 0;
  let crossedOlder = false;

  while (page < 30 && !crossedOlder) {
    const url = `https://trackmania.io/api/totd/${page}`;
    const data = await getJson(url, "trackmaniaevents.com (cotd-page-walk)");
    const list = Array.isArray(data?.days) ? data.days : [];
    if (!list.length) break;

    // Track month bounds on this page
    let pageOldest = null;

    for (const d of list) {
      const date =
        toISO(d?.day) || toISO(d?.date) || toISO(d?.start) || toISO(d?.end);
      if (!date) continue;
      if (!pageOldest || date < pageOldest) pageOldest = date;
      if (isoMonth(date) === targetYM) {
        collected.push({ raw: d, date });
      }
    }

    // Once the oldest item on this page is older than target month, we can stop
    if (pageOldest && isoMonth(pageOldest) < targetYM && collected.length) {
      crossedOlder = true;
    } else {
      page++;
    }
  }

  collected.sort((a, b) => a.date.localeCompare(b.date));
  return { days: collected, debug: { strategy: "pages", pagesScanned: page + 1, got: collected.length } };
}

/* ---------- main ---------- */
async function main() {
  console.log(`Fetching TOTDs for ${MONTH} from trackmania.io ...`);
  let result = await fetchByMonthIndex(MONTH);

  if (!result.days.length) {
    console.log(`Index path found 0 or mismatched month, falling back to page-walk...`, result.debug);
    result = await fetchByPageWalk(MONTH);
  }

  if (!result.days.length) {
    console.error(`No TOTDs found for ${MONTH}. Debug:`, result.debug);
    process.exit(1);
  }

  const out = [];
  for (const item of result.days) {
    const d = item.raw;
    const date = item.date;
    const mapUid = d?.mapUid || d?.map?.uid || "";
    const name = cleanTM(d?.name || d?.map?.name || "Track of the Day");

    // Inline author/thumbnail if present
    let author = cleanTM(d?.map?.authorplayer?.name || d?.map?.authorname || d?.map?.author || "");
    let thumbnail = d?.map?.thumbnail || "";

    // Fallback enrich
    if (!author || !thumbnail) {
      const extra = await enrichMap(mapUid);
      if (!author && extra.author) author = extra.author;
      if (!thumbnail && extra.thumbnail) thumbnail = extra.thumbnail;
    }

    // Winners best-effort
    let winners = [];
    try { winners = await getCotdWinnersFromTmio(date); } catch {}

    out.push({
      date,
      name,
      author: author || "Unknown",
      mapUid,
      thumbnail: thumbnail || "",
      image: thumbnail || "",
      winners
    });
  }

  await mkdir(OUTDIR, { recursive: true });
  await writeFile(
    OUTFILE,
    JSON.stringify({ month: MONTH, updated: new Date().toISOString(), tracks: out }, null, 2)
  );
  console.log(`✅ Wrote ${OUTFILE} (${out.length} days) -> ${OUTFILE}`);
}

main().catch(err => {
  console.error("COTD fetch failed:", err);
  process.exit(1);
});
