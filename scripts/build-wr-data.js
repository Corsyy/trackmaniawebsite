import fs from "fs";
import path from "path";
import fetch from "node-fetch";

const API_BASE = process.env.WR_API_BASE || "https://trackmaniawebsite.onrender.com";

const OUT_RECENT = path.join("data", "recent-wrs", "latest.json");
const OUT_PLAYERS = path.join("data", "wr-leaderboard", "latest.json");

async function fetchJson(url) {
  const res = await fetch(url, {
    headers: {
      "User-Agent": "trackmaniaevents.com wr static builder"
    }
  });

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`${url} -> ${res.status} ${text}`);
  }

  return res.json();
}

function writeJson(filePath, data) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2));
}

async function main() {
  console.log("Fetching WR leaderboard...");
  const leaderboard = await fetchJson(`${API_BASE}/api/wr-players?limit=1000`);

  console.log("Fetching recent WRs...");
  const recent = await fetchJson(`${API_BASE}/api/wr-latest?limit=1000`);

  const builtAt = new Date().toISOString();

  const leaderboardOut = {
    builtAt,
    source: "render-api",
    ...leaderboard
  };

  const recentOut = {
    builtAt,
    source: "render-api",
    ...recent
  };

  writeJson(OUT_PLAYERS, leaderboardOut);
  writeJson(OUT_RECENT, recentOut);

  console.log(`Wrote ${OUT_PLAYERS}`);
  console.log(`Wrote ${OUT_RECENT}`);
  console.log("Done.");
}

main().catch((err) => {
  console.error("build-wr-data failed:");
  console.error(err);
  process.exit(1);
});
