// scripts/cotd-fetcher.js
// Full-month Track of the Day from trackmania.io (no tokens).
// Writes TWO files so the frontend can be flexible:
//   data/totd/YYYY-MM.json
//   data/totd/October-2025.json
//
// Usage:
//   node scripts/cotd-fetcher.js          -> current month (/api/totd/0)
//   node scripts/cotd-fetcher.js prev     -> previous month (/api/totd/1)
//   node scripts/cotd-fetcher.js 0|1|2... -> explicit index (0=current, 1=prev, ...)

import { writeFile, mkdir } from "fs/promises";
import path from "path";

const ARG = process.argv[2] || "0";           // "prev" | "0" | "1" | "2"...
const INDEX = ARG === "prev" ? 1 : Number.isFinite(Number(ARG)) ? Number(ARG) : 0;
const OUTDIR = path.join("data", "totd");

// --- helpers ---------------------------------------------------------------
function cleanTM(str = "") {
  return String(str).replace(/\$[0-9a-fA-F]{3}|\$[a-zA-Z]|\$[0-9a-fA-F]/g, "").trim();
}
function looksLikeUUID(s = "") {
  return /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i.test(s);
}
async function getJson(url) {
  const r = await fetch(url, {
    headers: { "User-Agent": "Mozilla/5.0 (Trackmania Events cotd-fetcher)" },
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
const slugMonth = (s) => String(s || "").trim().replace(/\s+/g, "-");

// Enrich author + thumbnail via map endpoint
async function enrichByMapUid(uid) {
  if (!uid) return {};
  try {
    const m = await getJson(`https://trackmania.io/api/map/${encodeURIComponent(uid)}`);
    const authorName = m?.authorplayer?.name || m?.authorname || m?.author || "";
    const thumbnail = m?.thumbnail || m?.thumbnailUrl || m?.thumbnailURL || "";
    return {
      author_name: authorName ? cleanTM(authorName) : "",
      thumbnail: thumbnail || "",
    };
  } catch {
    return {};
  }
}

// Winners (best-effort; tolerant to shape changes; skip quietly if missing)
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
      if (winners.length) return winners.sort((a, b) => a.division - b.division);
    } catch { /* keep trying */ }
  }
  // per-division fallback with short-circuit after 3 misses
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
    const url = `https://trackmania.io/api/totd/${INDEX}`;
    const payload = await getJson(url);

    // tm.io exposes a human-readable "month" / season name (e.g., "October 2025")
    const monthName = payload?.month || "";
    const days = Array.isArray(payload?.days) ? payload.days : [];
    if (!days.length) {
      throw new Error(`tm.io returned no days for ${url}`);
    }

    // Build full list for the season/month returned by /totd/{index}
    const entries = [];
    for (const d of days) {
      const date = toISO(d?.day || d?.date || d?.start || d?.end);
      const mapUid = d?.mapUid || d?.map?.uid || "";
      const rawName = d?.name || d?.map?.name || "Track of the Day";
      const rawAuthor =
        d?.author ||
        d?.map?.author ||
        d?.map?.authorname ||
        d?.map?.authorplayer?.name ||
        "";

      let base = {
        date: date || "",
        name: cleanTM(rawName),
        author: cleanTM(rawAuthor || ""),
        mapUid,
        thumbnail: d?.map?.thumbnail || "",
      };

      // Enrich if author looks like a UUID or no thumbnail
      if (!base.thumbnail || looksLikeUUID(base.author)) {
        const extra = await enrichByMapUid(mapUid);
        if (extra.author_name && !looksLikeUUID(extra.author_name)) {
          base.author = extra.author_name;
        }
        if (extra.thumbnail && !base.thumbnail) {
          base.thumbnail = extra.thumbnail;
        }
      }

      // Winners (best-effort)
      let winners = [];
      try { if (base.date) winners = await getCotdWinners(base.date); } catch {}

      entries.push({
        date: base.date,
        name: base.name,
        author: base.author || "Unknown",
        mapUid: base.mapUid,
        image: base.thumbnail || "",
        thumbnail: base.thumbnail || "",
        winners, // array: [{ division, displayName }]
      });
    }

    // Sort chronologically
    entries.sort((a, b) => (a.date || "").localeCompare(b.date || ""));

    // Derive numeric month from the first dated entry for convenience
    const firstISO = entries.find(e => e.date)?.date || "";
    const numericYM = isoMonth(firstISO) || ""; // e.g., "2025-10"
    const namedSlug = monthName ? slugMonth(monthName) : (numericYM || "unknown-month");

    // Prepare output payload
    const outPayload = {
      month: monthName || numericYM || "Unknown",
      month_numeric: numericYM || null,
      updated: new Date().toISOString(),
      tracks: entries,
    };

    await mkdir(OUTDIR, { recursive: true });

    // Write BOTH files so frontend can read either style
    if (numericYM) {
      await writeFile(
        path.join(OUTDIR, `${numericYM}.json`),
        JSON.stringify(outPayload, null, 2)
      );
      console.log(`✅ Wrote data/totd/${numericYM}.json (${entries.length} days).`);
    }

    await writeFile(
      path.join(OUTDIR, `${namedSlug}.json`),
      JSON.stringify(outPayload, null, 2)
    );
    console.log(`✅ Wrote data/totd/${namedSlug}.json (${entries.length} days).`);
  } catch (err) {
    console.error("COTD fetch failed:", err);
    process.exit(1);
  }
}

main();
