// server.js
// npm i express node-fetch
import express from "express";
import fetch from "node-fetch";

const {
  CLIENT_ID, CLIENT_SECRET, REFRESH_TOKEN,
  PORT = 3000
} = process.env;

const REFRESH_URL = "https://api.trackmania.com/api/access_token";           // OAuth refresh (Trackmania auth)  :contentReference[oaicite:3]{index=3}
const LIVE_BASE   = "https://live-services.trackmania.nadeo.live";

let tokenCache = { access: null, expiresAt: 0 };

async function getAccessToken() {
  const now = Date.now();
  if (tokenCache.access && tokenCache.expiresAt - 60_000 > now) return tokenCache.access;

  const body = new URLSearchParams({
    grant_type: "refresh_token",
    client_id: CLIENT_ID,
    client_secret: CLIENT_SECRET,
    refresh_token: REFRESH_TOKEN
  });

  const r = await fetch(REFRESH_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body
  });
  if (!r.ok) throw new Error(`Refresh failed ${r.status}: ${await r.text()}`);
  const data = await r.json();
  tokenCache.access = data.access_token;
  tokenCache.expiresAt = now + (data.expires_in ?? 3600) * 1000;
  return tokenCache.access;
}

// Fetch the current official campaign (latest) and return its map UIDs
async function getCurrentCampaignMapUids() {
  const access = await getAccessToken();
  const url = `${LIVE_BASE}/api/campaign/official?offset=0&length=1`; // returns latest campaign, incl. playlist[].mapUid  :contentReference[oaicite:4]{index=4}
  const r = await fetch(url, { headers: { Authorization: `nadeo_v1 t=${access}` }});
  if (!r.ok) throw new Error(`Campaign fetch failed ${r.status}: ${await r.text()}`);
  const j = await r.json();
  const latest = j?.campaignList?.[0];
  if (!latest) return [];
  return latest.playlist.map(p => p.mapUid);
}

// Get WR (top-1) for a single mapUid
async function fetchWR(mapUid) {
  const access = await getAccessToken();
  const url = `${LIVE_BASE}/api/token/leaderboard/group/Personal_Best/map/${mapUid}/top?onlyWorld=true&length=1`; // :contentReference[oaicite:5]{index=5}
  const r = await fetch(url, { headers: { Authorization: `nadeo_v1 t=${access}` }});
  if (!r.ok) throw new Error(`WR fetch failed ${r.status}: ${await r.text()}`);
  const j = await r.json();
  const rec = j?.tops?.[0]?.top?.[0];
  if (!rec) return null;
  return {
    mapUid,
    accountId: rec.accountId,
    timeMs: rec.score,           // milliseconds
    timestamp: rec.timestamp     // unix seconds; provided per docs
  };
}

// Resolve display names (public OAuth endpoint; alternative to removed Core route)  :contentReference[oaicite:6]{index=6}
async function idToNames(accountIds) {
  if (!accountIds.length) return {};
  const access = await getAccessToken(); // OAuth token works as Bearer per docs page
  const url = `https://api.trackmania.com/api/display-names/account-ids?accountId=${accountIds.join("&accountId=")}`; // :contentReference[oaicite:7]{index=7}
  const r = await fetch(url, { headers: { Authorization: `Bearer ${access}` }});
  if (!r.ok) return {};
  const arr = await r.json(); // [{accountId, displayName}]
  const map = {};
  for (const it of arr) map[it.accountId] = it.displayName || it.accountId;
  return map;
}

// API: returns [{mapUid, holder, timeMs, timestamp}]
const cache = { rows: [], fetchedAt: 0 };

async function buildLeaderboard() {
  const uids = await getCurrentCampaignMapUids();
  const results = await Promise.allSettled(uids.map(fetchWR));
  const rows = results
    .filter(r => r.status === "fulfilled" && r.value)
    .map(r => r.value);
  const ids = [...new Set(rows.map(r => r.accountId))];
  const names = await idToNames(ids);
  cache.rows = rows.map(r => ({ ...r, holder: names[r.accountId] || r.accountId }));
  cache.fetchedAt = Date.now();
}

setInterval(() => buildLeaderboard().catch(console.error), 60_000); // refresh every 60s
setTimeout(() => buildLeaderboard().catch(console.error), 1000);    // initial load

const app = express();
app.get("/api/wr-leaderboard", (_req, res) => res.json(cache));
app.use(express.static("public"));
app.listen(PORT, () => console.log(`WR leaderboard running on :${PORT}`));
