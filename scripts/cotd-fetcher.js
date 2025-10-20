// scripts/cotd-fetcher.js
// Full-month Track of the Day from trackmania.io (no tokens).
// Writes: data/totd/YYYY-MM.json
// Usage: node scripts/cotd-fetcher.js           -> current month (auto-rolls)
//        node scripts/cotd-fetcher.js 2025-09   -> specific month (optional)

import { writeFile, mkdir } from "fs/promises";
import path from "path";

const ARG_MONTH = process.argv[2] || ""; // optional "YYYY-MM"
const OUTDIR = path.join("data", "totd");

// --- helpers ---------------------------------------------------------------

function cleanTM(str = "") {
  // Strip Trackmania color/style codes like $fff, $i, $o, etc.
  return String(str).replace(/\$[0-9a-fA-F]{3}|\$[a-zA-Z]|\$[0-9a-fA-F]/g, "").trim();
}

function looksLikeUUID(s = "") {
  return /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i.test(s);
}

async function getJson(url) {
  const r = await fetch(url, {
    headers: { "User-Agent": "trackmaniaevents.com (cotd-fetcher)" },
  });
  if (!r.ok) throw new Error(`${url} -> ${r.status} ${r.statusText}`);
  return r.json();
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
const isoMonth = (iso) => (iso || "").slice(0, 7);

// Best-effort enrichment by mapUid, if present
async function enrichByMapUid(uid) {
  if (!uid) return {};
  try {
    const m = await getJson(`https://trackmania.io/api/map/${encodeURIComponent(uid)}`);
    const authorName =
      m?.authorplayer?.name ||
      m?.authorname ||
      m?.author ||
      "";
    const thumbnail =
      m?.thumbnail ||
      m?.thumbnailUrl ||
      m?.thumbnailURL ||
      "";
    return {
      author_name: authorName ? cleanTM(authorName) : "",
      thumbnail: thumbnail || "",
    };
  } catch {
    return {};
  }
}

// Winners (best-effort; tolerant to shape changes; skips quietly if missing)
async function getCotdWinners(dateISO) {
  const tryUrls = [
    `https://trackmania.io/api/cotd/${dateISO}`,
    `https://trackmania.io/api/cotd/${dateISO}/divisions`,
  ];
  for (const url of tryUrls) {
    try {
      const data = await getJson(url);
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
            displayName: cleanTM(top.displayName || top.name || top.player || "Unknown"),
          });
        }
      }
      if (winners.length) return winners.sort((a,b)=>a.division-b.division);
    } catch { /* try next */ }
  }
  // Per-division fallback (stop after 3 misses)
  let misses = 0;
  const winners = [];
  for (let div = 1; div <= 60; div++) {
    try {
      const data = await getJson(`https://trackmania.io/api/cotd/${dateISO}/divisions/${div}`);
      const top =
        data?.winner ||
        (Array.isArray(data?.results) && data.results[0]) ||
        (Array.isArray(data?.rankings) && data.rankings[0]) ||
        null;
      if (top) {
        winners.push({
          division: div,
          displayName: cleanTM(top.displayName || top.name || top.player || "Unknown"),
        });
        misses = 0;
      } else if (++misses >= 3) break;
    } catch {
      if (++misses >= 3) break;
    }
  }
  return winners;
}

// --- main ------------------------------------------------------------------

async function main() {
  try {
    // Use the same feed you know works
    const totd = await getJson("https://trackmania.io/api/totd/0");
    const days = Array.isArray(totd?.days) ? totd.days : [];
    if (!days.length) throw new Error("tm.io returned no days");

    // Parse all dates in the feed
    const parsed = days
      .map(d => {
        const date = toISO(d?.day || d?.date || d?.start || d?.end);
        return date ? { d, date } : null;
      })
      .filter(Boolean);

    // Figure out target month
    const newestISO = parsed.map(x => x.date).sort((a,b)=>b.localeCompare(a))[0];
    const visibleYM = isoMonth(newestISO) || new Date().toISOString().slice(0,7);
    const TARGET_YM = ARG_MONTH || visibleYM;

    // Try strict month filter first
    let monthItems = parsed.filter(x => isoMonth(x.date) === TARGET_YM);

    // 🔥 If strict filter yields 0 (edge case: site hasn’t flipped month yet),
    // just use EVERYTHING the feed returned and derive the month from newest.
    if (!monthItems.length) {
      console.warn(`No items for ${TARGET_YM} in /totd/0; using visible month ${visibleYM} from feed.`);
      monthItems = parsed; // keep all — they belong to the visible month
    }

    // Sort chronologically
    monthItems.sort((a,b)=>a.date.localeCompare(b.date));

    // Derive final month from data (so we write the correct filename)
    const finalYM = isoMonth(monthItems[0]?.date || TARGET_YM);

    const out = [];
    for (const { d, date } of monthItems) {
      const mapUid = d?.mapUid || d?.map?.uid || "";
      const rawName = d?.name || d?.map?.name || "Track of the Day";
      const rawAuthor =
        d?.author ||
        d?.map?.author ||
        d?.map?.authorname ||
        d?.map?.authorplayer?.name ||
        "";

      let base = {
        date,
        name: cleanTM(rawName),
        author: cleanTM(rawAuthor || ""),
        mapUid,
        thumbnail: d?.map?.thumbnail || "",
      };

      // Enrich if the author looks like a UUID or there’s no thumbnail
      if (!base.thumbnail || looksLikeUUID(base.author)) {
        const extra = await enrichByMapUid(mapUid);
        if (extra.author_name && !looksLikeUUID(extra.author_name)) base.author = extra.author_name;
        if (extra.thumbnail && !base.thumbnail) base.thumbnail = extra.thumbnail;
      }

      // Winners (don’t break if missing)
      let winners = [];
      try { winners = await getCotdWinners(date); } catch {}

      out.push({
        date: base.date,
        name: base.name,
        author: base.author || "Unknown",
        mapUid: base.mapUid,
        image: base.thumbnail || "",
        thumbnail: base.thumbnail || "",
        winners, // array: [{division, displayName}]
      });
    }

    await mkdir(OUTDIR, { recursive: true });
    const outfile = path.join(OUTDIR, `${finalYM}.json`);
    await writeFile(outfile, JSON.stringify({ month: finalYM, updated: new Date().toISOString(), tracks: out }, null, 2));
    console.log(`✅ Wrote ${outfile} (${out.length} days).`);
  } catch (err) {
    console.error("COTD fetch failed:", err);
    process.exit(1);
  }
}

main();
