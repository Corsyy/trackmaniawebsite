// scripts/cotd-fetcher.js
// Fetch recent Track of the Day entries from trackmania.io and save to cotd.json

import { writeFile } from "fs/promises";

const OUT = "cotd.json";

// --- helpers ---------------------------------------------------------------

function cleanTM(str = "") {
  // Strip Trackmania color/style codes like $fff, $i, $o, etc.
  return String(str)
    .replace(/\$[0-9a-fA-F]{3}|\$[a-zA-Z]|\$[0-9a-fA-F]/g, "")
    .trim();
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

// Best-effort enrichment by mapUid, if present
async function enrichByMapUid(uid) {
  if (!uid) return {};
  try {
    // trackmania.io map lookup (public). If this changes, enrichment silently fails.
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

// --- main ------------------------------------------------------------------

async function main() {
  try {
    // Page 0 is most recent; adjust if you want more pages.
    const totd = await getJson("https://trackmania.io/api/totd/0");
    const days = Array.isArray(totd?.days) ? totd.days : [];

    // take last 10 in chronological order from latest page
    const items = days.slice(0, 10);

    const out = [];
    for (const d of items) {
      const date = d?.day || d?.date || "";
      const mapUid = d?.mapUid || d?.map?.uid || "";
      const rawName = d?.name || d?.map?.name || "";
      const rawAuthor =
        d?.author ||
        d?.map?.author ||
        d?.map?.authorname ||
        d?.map?.authorplayer?.name ||
        "";

      let base = {
        date,
        name: cleanTM(rawName || "Track of the Day"),
        author: cleanTM(rawAuthor || ""),
        mapUid,
        thumbnail: d?.map?.thumbnail || "",
        // You can add more raw fields here if desired
      };

      // If author looks like a UUID or we have no thumbnail, try to enrich
      if (!base.thumbnail || looksLikeUUID(base.author)) {
        const extra = await enrichByMapUid(mapUid);
        if (extra.author_name && !looksLikeUUID(extra.author_name)) {
          base.author = extra.author_name;
        }
        if (extra.thumbnail && !base.thumbnail) {
          base.thumbnail = extra.thumbnail;
        }
      }

      // Normalize for frontend expectations
      out.push({
        date: base.date,
        name: base.name,
        author: base.author || "Unknown",
        mapUid: base.mapUid,
        image: base.thumbnail || "",     // your page uses 'image' OR 'thumbnail'
        thumbnail: base.thumbnail || "",
        // winner fields left blank; can be enriched later when you find a stable COTD winner API
        cotd_winner: "",
      });
    }

    const payload = {
      updated: new Date().toISOString(),
      tracks: out,
    };

    await writeFile(OUT, JSON.stringify(payload, null, 2));
    console.log(`Wrote ${OUT} with ${out.length} tracks.`);
  } catch (err) {
    console.error("COTD fetch failed:", err);
    process.exit(1);
  }
}

main();
