import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Where to save the output JSON in your repo
const OUTFILE = path.resolve(__dirname, "../cotd.json");

// Public community API (no keys needed). If this ever changes, update here.
const API_TOTD = "https://trackmania.io/api/totd";

function safe(v, fallback = "") {
  return v ?? fallback;
}

async function fetchTotd() {
  const res = await fetch(API_TOTD, { headers: { "accept": "application/json" } });
  if (!res.ok) throw new Error(`TOTD fetch failed: ${res.status} ${res.statusText}`);
  return res.json();
}

function normalize(items) {
  // Your /cotd.html expects: map_name, author, ctd_winner, date, image
  // We’ll fill ctd_winner as "" for now (winner API is harder; can be added later)
  return items.map((d) => {
    const map = d?.map || {};
    return {
      map_name: safe(map.name, "Track of the Day"),
      author: safe(map.author, "Unknown"),
      ctd_winner: "",                 // optional: add later if you wire a winners source
      date: safe(d?.date, ""),
      image: safe(map.thumbnail, ""), // trackmania.io usually provides thumbnails
    };
  });
}

async function main() {
  const data = await fetchTotd();

  // trackmania.io returns seasons → [0] latest → days[]
  const latestSeason = data?.seasons?.[0];
  const days = latestSeason?.days || [];

  // newest first (days are usually oldest->newest), then take last 10
  const normalized = normalize(days.slice(-10).reverse());

  await fs.writeFile(OUTFILE, JSON.stringify(normalized, null, 2));
  console.log(`Wrote ${normalized.length} items to cotd.json`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
