import { writeFile, mkdir } from "fs/promises";
import path from "path";

const MONTH = (process.argv[2] || new Date().toISOString().slice(0, 7)); // "YYYY-MM"
const OUTDIR = path.join("data", "totd");
const OUTFILE = path.join(OUTDIR, `${MONTH}.json`);

// -------------- helpers --------------
function cleanTM(str = "") {
  // Strip Trackmania color/style codes like $fff, $i, etc.
  return String(str)
    .replace(/\$[0-9a-fA-F]{3}|\$[a-zA-Z]|\$[0-9a-fA-F]/g, "")
    .trim();
}

async function getJson(url, ua = "trackmaniaevents.com (cotd-fetcher)") {
  const r = await fetch(url, { headers: { "User-Agent": ua } });
  if (!r.ok) throw new Error(`${url} -> ${r.status} ${r.statusText}`);
  return r.json();
}

// Map enrichment via tm.io (author + thumbnail)
async function enrichMap(uid) {
  if (!uid) return { author: "", thumbnail: "" };
  try {
    const m = await getJson(
      `https://trackmania.io/api/map/${encodeURIComponent(uid)}`,
      "trackmaniaevents.com (cotd-enrich)"
    );
    const author =
      m?.authorplayer?.name || m?.authorname || m?.author || "";
    const thumbnail =
      m?.thumbnail || m?.thumbnailUrl || m?.thumbnailURL || "";
    return { author: cleanTM(author || ""), thumbnail: thumbnail || "" };
  } catch {
    return { author: "", thumbnail: "" };
  }
}

// Walk /api/totd/{page} until we have the whole month.
async function fetchMonthDays(monthStr) {
  const days = [];
  let page = 0;
  while (page < 30) {
    const data = await getJson(
      `https://trackmania.io/api/totd/${page}`,
      "trackmaniaevents.com (cotd-month)"
    );
    const list = Array.isArray(data?.days) ? data.days : [];
    if (!list.length) break;

    // Keep only items within the target month
    for (const d of list) {
      const date = d?.day || d?.date || "";
      if (date.startsWith(monthStr)) days.push(d);
    }

    // If this page includes anything older than the target month, and we already have some,
    // we can stop (we've collected the month).
    const crossedOlder = list.some(d => (d?.day || "").localeCompare(monthStr) < 0);
    if (days.length && crossedOlder) break;

    page++;
  }
  return days;
}

// -------------- winners (tm.io best-effort) --------------
async function getJsonTmio(url) {
  const r = await fetch(url, { headers: { "User-Agent": "trackmaniaevents.com (cotd-winners)" } });
  if (!r.ok) throw new Error(`${url} -> ${r.status} ${r.statusText}`);
  return r.json();
}

/**
 * Try to fetch Cup-of-the-Day winners from tm.io for a given ISO date (YYYY-MM-DD).
 * Returns: [{ division: number, displayName: string, accountId?: string }] or [].
 */
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
      if (winners.length) {
        winners.sort((a, b) => a.division - b.division);
        return winners;
      }
    } catch {
      // try next format
    }
  }

  // Fallback: query per-division endpoints 1..60; stop after 3 misses in a row
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

// -------------- main --------------
async function main() {
  console.log(`Fetching TOTDs for ${MONTH} from trackmania.io ...`);
  const monthDays = await fetchMonthDays(MONTH);

  if (!monthDays.length) {
    console.error(`No TOTDs found for ${MONTH}`);
    process.exit(1);
  }

  // Sort chronologically
  monthDays.sort((a, b) => (a?.day || "").localeCompare(b?.day || ""));

  const out = [];
  for (const d of monthDays) {
    const date = d?.day || d?.date || "";
    const mapUid = d?.mapUid || d?.map?.uid || "";
    const name = cleanTM(d?.name || d?.map?.name || "Track of the Day");

    // author/thumbnail (inline if present)
    let author = cleanTM(
      d?.map?.authorplayer?.name || d?.map?.authorname || d?.map?.author || ""
    );
    let thumbnail = d?.map?.thumbnail || "";

    // fallback enrichment if needed
    if (!author || !thumbnail) {
      const extra = await enrichMap(mapUid);
      if (!author && extra.author) author = extra.author;
      if (!thumbnail && extra.thumbnail) thumbnail = extra.thumbnail;
    }

    // winners (best-effort; skips quietly if not available)
    let winners = [];
    try {
      winners = await getCotdWinnersFromTmio(date);
    } catch {
      winners = [];
    }

    out.push({
      date,
      name,
      author: author || "Unknown",
      mapUid,
      thumbnail: thumbnail || "",
      image: thumbnail || "",
      winners, // array of { division, displayName, accountId? }
    });
  }

  await mkdir(OUTDIR, { recursive: true });
  await writeFile(
    OUTFILE,
    JSON.stringify({ month: MONTH, updated: new Date().toISOString(), tracks: out }, null, 2)
  );
  console.log(`✅ Wrote ${OUTFILE} (${out.length} days).`);
}

main().catch(err => {
  console.error("COTD fetch failed:", err);
  process.exit(1);
});
