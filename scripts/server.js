import express from "express";
import fetch from "node-fetch";

const app = express();
app.use((req, res, next) => {
  res.setHeader("Access-Control-Allow-Origin", "https://trackmaniaevents.com");
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
  if (req.method === "OPTIONS") return res.sendStatus(200);
  next();
});

// ===== CONFIG =====
const WR_TTL_MS = 10 * 60 * 1000; // cache for 10 minutes
let wrCache = { ts: 0, data: null };
let playersCache = {};

// ===== NAD API HELPERS =====
async function nadeoToken() {
  const res = await fetch("https://prod.trackmania.core.nadeo.online/v2/authentication/token/basic", {
    method: "POST",
    headers: {
      "Authorization": "Basic " + Buffer.from(`${process.env.NADEO_CLIENT_ID}:${process.env.NADEO_CLIENT_SECRET}`).toString("base64"),
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      audience: "NadeoLiveServices",
      grant_type: "client_credentials"
    })
  });
  const j = await res.json();
  return j.access_token;
}

async function fetchJSON(url, token) {
  const res = await fetch(url, { headers: { Authorization: `nadeo_v1 t=${token}` } });
  return res.json();
}

// ===== MAP FETCHING =====
async function getAllSeasonalCampaigns(token) {
  const data = await fetchJSON("https://live-services.trackmania.nadeo.live/api/campaign/official?length=50", token);
  return data.campaignList || [];
}

async function getAllTOTDs(token) {
  const data = await fetchJSON("https://live-services.trackmania.nadeo.live/api/totd/season?length=50", token);
  return data.seasonList || [];
}

async function getMapWR(token, mapUid) {
  const url = `https://live-services.trackmania.nadeo.live/api/token/leaderboard/group/${mapUid}/map/${mapUid}/top?onlyWorld=true&length=1`;
  const data = await fetchJSON(url, token);
  if (!data.tops || !data.tops[0] || !data.tops[0].top[0]) return null;

  const wr = data.tops[0].top[0];
  return {
    mapUid,
    accountId: wr.accountId,
    timeMs: wr.score,
    timestamp: wr.timestamp,
  };
}

async function resolvePlayerName(accountId, token) {
  if (playersCache[accountId]) return playersCache[accountId];
  const res = await fetch(`https://prod.trackmania.core.nadeo.online/accounts/displayNames/?accountId[]=${accountId}`, {
    headers: { Authorization: `nadeo_v1 t=${token}` }
  });
  const data = await res.json();
  const name = data[0]?.displayName || accountId;
  playersCache[accountId] = name;
  return name;
}

// ===== MAIN WR LEADERBOARD =====
app.get("/api/wr-leaderboard", async (_req, res) => {
  try {
    const now = Date.now();
    if (wrCache.data && now - wrCache.ts < WR_TTL_MS) return res.json(wrCache.data);

    const token = await nadeoToken();

    // seasonal + totd
    const [seasonals, totds] = await Promise.all([
      getAllSeasonalCampaigns(token),
      getAllTOTDs(token)
    ]);

    const mapUids = [
      ...seasonals.flatMap(s => s.playlist?.map(p => p.mapUid) || []),
      ...totds.flatMap(s => s.days?.map(d => d.mapUid) || [])
    ];

    const wrs = [];
    for (const uid of mapUids) {
      const wr = await getMapWR(token, uid);
      if (wr) {
        wr.displayName = await resolvePlayerName(wr.accountId, token);
        wrs.push(wr);
      }
    }

    const payload = {
      rows: wrs.sort((a, b) => b.timestamp - a.timestamp),
      fetchedAt: now,
      total: wrs.length
    };

    wrCache = { ts: now, data: payload };
    res.json(payload);
  } catch (err) {
    console.error("WR leaderboard error:", err);
    res.status(500).json({ error: "Failed to load leaderboard", details: err.message });
  }
});

// ===== MOST WR PLAYERS =====
app.get("/api/wr-players", async (_req, res) => {
  try {
    const token = await nadeoToken();
    const data = wrCache.data?.rows || [];
    const count = {};
    for (const wr of data) {
      count[wr.displayName] = (count[wr.displayName] || 0) + 1;
    }
    const sorted = Object.entries(count)
      .map(([name, total]) => ({ name, total }))
      .sort((a, b) => b.total - a.total);
    res.json({ players: sorted, fetchedAt: Date.now() });
  } catch (err) {
    console.error("WR player list error:", err);
    res.status(500).json({ error: "Failed to load player list" });
  }
});

app.get("/", (_req, res) => res.send("OK"));
const PORT = process.env.PORT || 3000;
app.listen(PORT, "0.0.0.0", () => console.log(`✅ API running on ${PORT}`));
