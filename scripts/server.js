import express from "express";
import fetch from "node-fetch";

const app = express();

// === CONFIG ===
const CACHE_TTL = 1000 * 60 * 30; // 30 min cache
let wrCache = { ts: 0, data: [] };
let playerCache = {};
let displayCache = {};

const NADEO_LIVE_URL = "https://live-services.trackmania.nadeo.live";
const NADEO_CORE_URL = "https://prod.trackmania.core.nadeo.online";

// === CORS ===
app.use((req, res, next) => {
  res.setHeader("Access-Control-Allow-Origin", "https://trackmaniaevents.com");
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
  if (req.method === "OPTIONS") return res.sendStatus(200);
  next();
});

// === NAD AUTH ===
async function getAccessToken() {
  const res = await fetch(`${NADEO_CORE_URL}/v2/authentication/token/basic`, {
    method: "POST",
    headers: {
      Authorization:
        "Basic " +
        Buffer.from(
          `${process.env.NADEO_CLIENT_ID}:${process.env.NADEO_CLIENT_SECRET}`
        ).toString("base64"),
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      audience: "NadeoLiveServices",
      grant_type: "client_credentials",
    }),
  });
  const j = await res.json();
  return j.access_token;
}

async function getJSON(url, token) {
  const res = await fetch(url, { headers: { Authorization: `nadeo_v1 t=${token}` } });
  return res.json();
}

// === FETCH ALL CAMPAIGN + TOTD MAPS ===
async function getAllMapUids(token) {
  const [campaigns, totdSeasons] = await Promise.all([
    getJSON(`${NADEO_LIVE_URL}/api/campaign/official?length=50`, token),
    getJSON(`${NADEO_LIVE_URL}/api/totd/season?length=50`, token),
  ]);

  const campaignUids = (campaigns.campaignList || []).flatMap(c => c.playlist?.map(m => m.mapUid) || []);
  const totdUids = (totdSeasons.seasonList || []).flatMap(s => s.days?.map(d => d.mapUid) || []);
  return [...new Set([...campaignUids, ...totdUids])];
}

// === FETCH WR FOR MAP ===
async function getMapWR(token, mapUid) {
  const data = await getJSON(
    `${NADEO_LIVE_URL}/api/token/leaderboard/group/${mapUid}/map/${mapUid}/top?onlyWorld=true&length=1`,
    token
  );
  const wr = data?.tops?.[0]?.top?.[0];
  if (!wr) return null;
  return {
    mapUid,
    accountId: wr.accountId,
    timeMs: wr.score,
    timestamp: wr.timestamp,
  };
}

// === RESOLVE DISPLAY NAME ===
async function resolveDisplayName(accountId, token) {
  if (displayCache[accountId]) return displayCache[accountId];
  const url = `${NADEO_CORE_URL}/accounts/displayNames/?accountId[]=${accountId}`;
  const res = await fetch(url, { headers: { Authorization: `nadeo_v1 t=${token}` } });
  const data = await res.json();
  const name = data?.[0]?.displayName || accountId;
  displayCache[accountId] = name;
  return name;
}

// === BUILD FULL WR LIST ===
async function buildLeaderboard() {
  const token = await getAccessToken();
  const uids = await getAllMapUids(token);
  const wrs = [];

  for (const uid of uids) {
    const wr = await getMapWR(token, uid);
    if (wr) {
      wr.displayName = await resolveDisplayName(wr.accountId, token);
      wrs.push(wr);
    }
  }

  const sorted = wrs.sort((a, b) => b.timestamp - a.timestamp);
  wrCache = { ts: Date.now(), data: sorted };
  return sorted;
}

// === ENDPOINTS ===
app.get("/api/wr-leaderboard", async (req, res) => {
  try {
    if (Date.now() - wrCache.ts < CACHE_TTL && wrCache.data.length > 0)
      return res.json({ rows: wrCache.data, fetchedAt: wrCache.ts });

    const wrs = await buildLeaderboard();
    res.json({ rows: wrs, fetchedAt: Date.now() });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "Failed to load WR leaderboard" });
  }
});

app.get("/api/wr-players", async (req, res) => {
  try {
    if (!wrCache.data.length) await buildLeaderboard();
    const playerCounts = {};

    wrCache.data.forEach((wr) => {
      const name = wr.displayName || wr.accountId;
      playerCounts[name] = (playerCounts[name] || 0) + 1;
    });

    const leaderboard = Object.entries(playerCounts)
      .map(([name, count]) => ({ name, count }))
      .sort((a, b) => b.count - a.count);

    res.json({ players: leaderboard, fetchedAt: Date.now() });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "Failed to load WR players" });
  }
});

app.get("/", (_req, res) => res.send("OK"));
const PORT = process.env.PORT || 3000;
app.listen(PORT, "0.0.0.0", () =>
  console.log(`✅ API running on port ${PORT}`)
);
