import { writeFile, mkdir } from "fs/promises";
import path from "path";

const OUT_LEGACY = "cotd.json"; // keep your old file
const MONTH_ARG = process.argv[2] || ""; // optional "YYYY-MM"
const OUTDIR = path.join("data", "totd");

// ---- helpers (same spirit as yours) ---------------------------------
function cleanTM(str = "") {
  return String(str).replace(/\$[0-9a-fA-F]{3}|\$[a-zA-Z]|\$[0-9a-fA-F]/g, "").trim();
}
function looksLikeUUID(s = "") {
  return /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i.test(s);
}
async function getJson(url, ua = "trackmaniaevents.com (cotd-fetcher)") {
  const r = await fetch(url, { headers: { "User-Agent": ua } });
  if (!r.ok) throw new Error(`${url} -> ${r.status} ${r.statusText}`);
  return r.json();
}

// Map enrichment (same idea you used)
async function enrichByMapUid(uid) {
  if (!uid) return { author_name: "", thumbnail: "" };
  try {
    const m = await getJson(`https://trackmania.io/api/map/${encodeURIComponent(uid)}`, "trackmaniaevents.com (cotd-enrich)");
    const authorName = m?.authorplayer?.name || m?.authorname || m?.author || "";
    const thumbnail = m?.thumbnail || m?.thumbnailUrl || m?.thumbnailURL || "";
    return { author_name: cleanTM(authorName || ""), thumbnail: thumbnail || "" };
  } catch {
    return { author_name: "", thumbnail: "" };
  }
}

// Winners (best-effort; skips quietly if tm.io has gaps)
async function getCotdWinnersFromTmio(dateISO) {
  const tryUrls = [
    `https://trackmania.io/api/cotd/${dateISO}`,
    `https://trackmania.io/api/cotd/${dateISO}/divisions`,
  ];
  for (const url of tryUrls) {
    try {
      const data = await getJson(url, "trackmaniaevents.com (cotd-winners)");
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
  // per-division fallback (short-circuit after 3 misses)
  let misses = 0;
  const winners = [];
  for (let div = 1; div <= 60; div++) {
    try {
      const data = await getJson(`https://trackmania.io/api/cotd/${dateISO}/divisions/${div}`, "trackmaniaevents.com (cotd-winners-div)");
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

function iso(dateLike) {
  if (!dateLike) return null;
  if (typeof dateLike === "number") {
    const ms = dateLike < 2e10 ? dateLike * 1000 : dateLike;
    const d = new Date(ms);
    return isNaN(d) ? null : d.toISOString().slice(0,10);
  }
  if (/^\d{4}-\d{2}-\d{2}/.test(String(dateLike))) return String(dateLike).slice(0,10);
  const t = Date.parse(String(dateLike));
  return Number.isNaN(t) ? null : new Date(t).toISOString().slice(0,10);
}
const ym = (s) => (s || "").slice(0,7);

// ---- main ------------------------------------------------------------
async function main() {
  try {
    // Get the latest month payload (the one you already used)
    const totd = await getJson("https://trackmania.io/api/totd/0");
    const days = Array.isArray(totd?.days) ? totd.days : [];
    if (!days.length) throw new Error("tm.io returned no days");

    // Decide which month to output:
    // - If user passed YYYY-MM, use it.
    // - Else, use the month of the newest item in /totd/0.
    const newest = days
      .map(d => iso(d?.day || d?.date || d?.start || d?.end))
      .filter(Boolean)
      .sort((a,b)=>b.localeCompare(a))[0];
    const targetYM = MONTH_ARG || ym(newest) || new Date().toISOString().slice(0,7);

    // Keep ONLY items from the target month
    const monthItems = days
      .map(d => {
        const date = iso(d?.day || d?.date || d?.start || d?.end);
        return date ? { d, date } : null;
      })
      .filter(Boolean)
      .filter(x => ym(x.date) === targetYM)
      .sort((a,b)=>a.date.localeCompare(b.date));

    if (!monthItems.length) throw new Error(`No TOTDs found for ${targetYM}`);

    // Build normalized records (authors, thumbs, winners)
    const full = [];
    for (const { d, date } of monthItems) {
      const mapUid = d?.mapUid || d?.map?.uid || "";
      const rawName = d?.name || d?.map?.name || "Track of the Day";
      let author =
        d?.map?.authorplayer?.name ||
        d?.map?.authorname ||
        d?.map?.author ||
        "";
      let thumbnail = d?.map?.thumbnail || "";

      // Enrich if needed
      if (!author || !thumbnail || looksLikeUUID(author)) {
        const extra = await enrichByMapUid(mapUid);
        if ((!author || looksLikeUUID(author)) && extra.author_name) author = extra.author_name;
        if (!thumbnail && extra.thumbnail) thumbnail = extra.thumbnail;
      }

      // Winners (best-effort; won't throw)
      let winners = [];
      try { winners = await getCotdWinnersFromTmio(date); } catch {}

      full.push({
        date,
        name: cleanTM(rawName),
        author: author ? cleanTM(author) : "Unknown",
        mapUid,
        thumbnail: thumbnail || "",
        image: thumbnail || "",
        winners
      });
    }

    // Write month file
    await mkdir(OUTDIR, { recursive: true });
    const monthOut = path.join(OUTDIR, `${targetYM}.json`);
    await writeFile(monthOut, JSON.stringify({ month: targetYM, updated: new Date().toISOString(), tracks: full }, null, 2));
    console.log(`✅ Wrote ${monthOut} (${full.length} days)`);

    // Also update legacy cotd.json with the last 10 (so your old page keeps working)
    const last10 = full.slice(-10).reverse();
    await writeFile(OUT_LEGACY, JSON.stringify({ updated: new Date().toISOString(), tracks: last10 }, null, 2));
    console.log(`✅ Wrote ${OUT_LEGACY} (last 10 from ${targetYM})`);
  } catch (err) {
    console.error("COTD fetch failed:", err);
    process.exit(1);
  }
}

main();
