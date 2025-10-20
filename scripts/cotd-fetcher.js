// scripts/cotd-fetcher.js
// Fetch last ~10 TOTDs via trackmania.io (public, no key), write cotd.json at repo root.

import { writeFile } from "fs/promises";

const OUT = "cotd.json";

async function getJson(url) {
  const r = await fetch(url, { headers: { "User-Agent": "trackmaniaevents.com" } });
  if (!r.ok) throw new Error(`${url} -> ${r.status} ${r.statusText}`);
  return r.json();
}

async function main() {
  try {
    // Page 0 is latest
    const totd = await getJson("https://trackmania.io/api/totd/0");
    const items = Array.isArray(totd?.days) ? totd.days.slice(0, 10) : [];

    const simplified = items.map(d => ({
      date: d?.day,                         // e.g., "2025-10-24"
      name: d?.name || d?.map?.name || "",
      author: d?.author || d?.map?.author || "",
      mapUid: d?.mapUid || d?.map?.uid || "",
      // Optional cover image (sometimes present)
      thumbnail: d?.map?.thumbnail || "",
      // Cup of the Day info is not directly on this endpoint; you can enrich later if desired
    }));

    await writeFile(OUT, JSON.stringify({ updated: new Date().toISOString(), tracks: simplified }, null, 2));
    console.log(`Wrote ${OUT} with ${simplified.length} tracks.`);
  } catch (err) {
    console.error("COTD fetch failed:", err);
    process.exit(1);
  }
}

main();
