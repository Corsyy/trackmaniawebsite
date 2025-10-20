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
  // index 0 = current month; +1 per month going back
  return (cy - ty) * 12 + (cm - tm);
}
function toISO(dateLike) {
  // try "YYYY-MM-DD" or epoch seconds or ms
  if (!dateLike) return null;
  if (typeof dateLike === "number") {
    const ms = dateLike < 2e10 ? dateLike * 1000 : dateLike;
    const d = new Date(ms);
    if (!isNaN(d)) return d.toISOString().slice(0, 10);
    return null;
  }
  if (/^\d{4}-\d{2}-\d{2}/.test(String(dateLike))) return String(dateLike).slice(0, 10);
  const t = Date.parse(String(dateLike));
  if (Number.isNaN(t)) return null;
  return new Date(t).toISOString().slice(0, 10);
}

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

/* ---------- winners (tm.io best-effort, tolerant to shape changes) ---------- */
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

/* ---------- fetch target month via tm.io MONTH INDEX ---------- */
async function fetchMonthByIndex(targetYM) {
  const index = ymDiffIndex(targetYM);
  const data = await getJson(
    `https://trackmania.io/api/totd/${index}`,
    "trackmaniaevents.com (cotd-month)"
  );

  const days = Array.isArray(data?.days) ? data.days : [];
  // Filter to exactly the requested month (tm.io should already give the right month)
  const filtered = [];
  for (const d of days) {
    const date =
      toISO(d?.day) || toISO(d?.date) || toISO(d?.start) || toISO(d?.end);
    if (!date) continue;
    if (date.slice(0, 7) === targetYM) {
      filtered.push({ raw: d, date });
    }
  }
  // Sort chronological
  filtered.sort((a, b) => a.date.localeCompare(b.date));
  return filtered;
}

/* ---------- main ---------- */
async function main() {
  console.log(`Fetching TOTDs for ${MONTH} from trackmania.io (index=${ymDiffIndex(MONTH)}) ...`);
  const monthDays = await fetchMonthByIndex(MONTH);

  if (!monthDays.length) {
    console.error(`No TOTDs found for ${MONTH}`);
    process.exit(1);
  }

  const out = [];
  for (const item of monthDays) {
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
  console.log(`✅ Wrote ${OUTFILE} (${out.length} days).`);
}

main().catch(err => {
  console.error("COTD fetch failed:", err);
  process.exit(1);
});
