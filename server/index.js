import express from "express";
import fetch from "node-fetch";
import helmet from "helmet";
import morgan from "morgan";
import cors from "cors";

const app = express();
app.use(helmet());
app.use(morgan("tiny"));
app.use(cors());
app.use(express.json());

// --- Simple in-memory cache to be nice to APIs ---
const cache = new Map();
const getCached = (key, ttlMs, fn) => {
  const now = Date.now();
  const hit = cache.get(key);
  if (hit && now - hit.t <= ttlMs) return hit.v;
  return fn().then(v => { cache.set(key, { v, t: now }); return v; });
};

// === Helpers for Trackmania OAuth (display-names) ===
// Uses your Trackmania CLIENT_ID/SECRET/REFRESH to get a short-lived access token.
async function getTMAccessToken() {
  const body = new URLSearchParams({
    grant_type: "refresh_token",
    client_id: process.env.TM_CLIENT_ID,
    client_secret: process.env.TM_CLIENT_SECRET,
    refresh_token: process.env.TM_REFRESH_TOKEN
  });
  const r = await fetch("https://api.trackmania.com/api/access_token", { method: "POST", body });
  if (!r.ok) throw new Error("TM OAuth failed");
  const j = await r.json();
  return j.access_token;
}

// === Helpers for Nadeo Live token (trophies / leaderboards) ===
// This is the typical Ubi -> NadeoServices -> NadeoLive chain.
// Keep these credentials safe in Render env vars.
async function getNadeoLiveToken() {
  // 1) Ubisoft ticket
  const u = await fetch("https://public-ubiservices.ubi.com/v3/profiles/sessions", {
    method: "POST",
    headers: {
      Authorization: "Basic " + Buffer.from(`${process.env.UBI_EMAIL}:${process.env.UBI_PASSWORD}`).toString("base64"),
      "Ubi-AppId": process.env.UBI_APP_ID,
      "Ubi-RequestedPlatformType": "uplay"
    }
  });
  if (!u.ok) throw new Error("Ubi sign-in failed");
  const { ticket } = await u.json();

  // 2) NadeoServices
  const ns = await fetch("https://prod.trackmania.core.nadeo.online/v2/authentication/token/ubiservices", {
    method: "POST",
    headers: { Authorization: `ubi_v1 t=${ticket}` }
  });
  if (!ns.ok) throw new Error("NadeoServices token failed");
  const nsJson = await ns.json();

  // 3) NadeoLive
  const nl = await fetch("https://live-services.trackmania.nadeo.live/api/token/refresh", {
    method: "POST",
    headers: { Authorization: `nadeo_v1 t=${nsJson.accessToken}` }
  });
  if (!nl.ok) throw new Error("NadeoLive token failed");
  const nlJson = await nl.json();

  return nlJson.accessToken;
}

/* =======================
   API ROUTES
   ======================= */

// Resolve display name <-> accountId
app.get("/api/players/resolve", async (req, res) => {
  try {
    const name = (req.query.name || "").toString().trim();
    const id   = (req.query.id   || "").toString().trim();
    if (!name && !id) return res.status(400).json({ error: "pass ?name= or ?id=" });

    const token = await getCached("tm_access", 15 * 60 * 1000, getTMAccessToken);
    const headers = { Authorization: `Bearer ${token}` };

    if (name) {
      const url = `https://api.trackmania.com/api/display-names/account-ids?displayName[]=${encodeURIComponent(name)}`;
      const j = await (await fetch(url, { headers })).json();
      return res.json({ accountId: j[name] || null, displayName: name });
    } else {
      const url = `https://api.trackmania.com/api/display-names?accountId[]=${encodeURIComponent(id)}`;
      const j = await (await fetch(url, { headers })).json();
      return res.json({ accountId: id, displayName: j[id] || null });
    }
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Basic profile (displayName, country, zone, avatar if you have a source)
app.get("/api/players/basic", async (req, res) => {
  try {
    const id = (req.query.id || "").toString().trim();
    if (!id) return res.status(400).json({ error: "?id=" });

    // Re-use display-names (for a canonical casing)
    const token = await getCached("tm_access", 15 * 60 * 1000, getTMAccessToken);
    const headers = { Authorization: `Bearer ${token}` };
    const url = `https://api.trackmania.com/api/display-names?accountId[]=${encodeURIComponent(id)}`;
    const j = await (await fetch(url, { headers })).json();
    const displayName = j[id] || null;

    // If you have a better source for avatar/country/zone, plug it here (e.g., trackmania.io or your own DB).
    // Keeping placeholders to avoid breaking the UI:
    res.json({
      accountId: id,
      displayName,
      country: null,
      zone: null,
      avatar: null
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Trophy points & ranks
app.get("/api/players/trophies", async (req, res) => {
  try {
    const id = (req.query.id || "").toString().trim();
    if (!id) return res.status(400).json({ error: "?id=" });

    const token = await getCached("nadeo_live", 10 * 60 * 1000, getNadeoLiveToken);
    const r = await fetch("https://live-services.trackmania.nadeo.live/api/token/leaderboard/trophy/player", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `nadeo_v1 t=${token}` },
      body: JSON.stringify({ listPlayer: [{ accountId: id }] })
    });
    if (!r.ok) throw new Error("trophy fetch failed");
    const j = await r.json();

    // Normalize a compact shape for the client:
    const p = (j && j.players && j.players[0]) || {};
    res.json({
      points: p.trophyPoints ?? null,
      worldRank: p.zoneRankings?.world?.position ?? null,
      countryRank: p.zoneRankings?.country?.position ?? null,
      regionRank: p.zoneRankings?.region?.position ?? null
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Recent records (basic MVP: check top boards of maps you care about)
const MAPS = []; // Fill with map UIDs from your seasonal campaigns + TOTDs (you already have these).
app.get("/api/players/records", async (req, res) => {
  try {
    const id = (req.query.id || "").toString().trim();
    if (!id) return res.status(400).json({ error: "?id=" });

    const token = await getCached("nadeo_live", 10 * 60 * 1000, getNadeoLiveToken);
    const headers = { Authorization: `nadeo_v1 t=${token}` };

    const results = [];
    for (const mapUid of MAPS) {
      const url = `https://live-services.trackmania.nadeo.live/api/token/leaderboard/group/Personal_Best/map/${mapUid}/top?onlyWorld=true&length=100`;
      const j = await (await fetch(url, { headers })).json();
      const row = (j?.top || []).find(r => r.accountId === id);
      if (row) {
        results.push({
          mapUid,
          position: row.position,
          time: row.score?.time,
          isWR: row.position === 1,
          timestamp: row.timestamp || null
        });
      }
    }

    // You can add map names by enriching with your campaign/TOTD JSON here.
    res.json({ entries: results.slice(0, 50) });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Health
app.get("/healthz", (_, res) => res.json({ ok: true }));

const PORT = process.env.PORT || 3001;
app.listen(PORT, () => console.log("API listening on :" + PORT));
