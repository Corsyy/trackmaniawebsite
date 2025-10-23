import express from "express";
import fetch from "node-fetch";

/**
 * ENV REQUIRED:
 *   REFRESH_TOKEN = your Nadeo refresh token (aud: NadeoLiveServices)
 *
 * Optional:
 *   CORS_ORIGIN = https://trackmaniaevents.com  (defaults to that if not set)
 */

const app = express();
const ORIGIN = process.env.CORS_ORIGIN || "https://trackmaniaevents.com";

// --- CORS ---
app.use((req, res, next) => {
  res.setHeader("Access-Control-Allow-Origin", ORIGIN);
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
  if (req.method === "OPTIONS") return res.sendStatus(200);
  next();
});

// --- Health ---
app.get("/", (_req, res) => res.send("OK"));
app.get("/healthz", (_req, res) => res.json({ ok: true }));
app.get("/api/ping", (_req, res) => res.json({ ok: true, ts: Date.now() }));

// ---------- Nadeo auth (refresh -> access) ----------
const NADEO_REFRESH = process.env.REFRESH_TOKEN; // keep this safe on Render
const CORE_REFRESH_URL = "https://prod.trackmania.core.nadeo.online/v2/authentication/token/refresh";

/** Cache the current live access token in memory. */
let cachedAccess = { token: null, expAt: 0 };

async function getLiveAccessToken() {
  const now = Date.now();
  if (cachedAccess.token && now < cachedAccess.expAt - 30_000) {
    return cachedAccess.token;
  }
  if (!NADEO_REFRESH) {
    throw new Error("Missing REFRESH_TOKEN env var");
  }

  // POST {} with Authorization: nadeo_v1 t=<refreshToken>
  const resp = await fetch(CORE_REFRESH_URL, {
    method: "POST",
    headers: {
      "Authorization": `nadeo_v1 t=${NADEO_REFRESH}`,
      "Content-Type": "application/json",
      "User-Agent": "trackmaniaevents.com/1.0 (Render)"
    },
    body: "{}"
  });

  if (!resp.ok) {
    const text = await resp.text();
    throw new Error(`Refresh failed ${resp.status}: ${text}`);
  }
  const data = await resp.json();
  const accessToken = data?.accessToken || data?.access_token || null;
  const expiresIn = data?.expiresIn || data?.expires_in || 3600;

  if (!accessToken) {
    throw new Error("No accessToken in refresh response");
  }

  cachedAccess = {
    token: accessToken,
    expAt: Date.now() + expiresIn * 1000
  };
  return cachedAccess.token;
}

// ---------- Live Services endpoints ----------
const LIVE_BASE = "https://live-services.trackmania.nadeo.live";

// Get current seasonal campaign (playlist contains mapUids)
// Docs: GET /api/campaign/official?offset=0&length=1  (v2)  → campaignList[0].playlist[].mapUid
// https://webservices.openplanet.dev/live/campaigns/campaigns-v2
async function getCurrentCampaign(accessToken) {
  const url = `${LIVE_BASE}/api/campaign/official?offset=0&length=1`;
  const r = await fetch(url, {
    headers: {
      "Authorization": `nadeo_v1 t=${accessToken}`,
      "User-Agent": "trackmaniaevents.com/1.0 (Render)"
    }
  });
  if (!r.ok) throw new Error(`campaign fetch ${r.status}`);
  const j = await r.json();
  const camp = j?.campaignList?.[0];
  if (!camp) throw new Error("No campaign returned");
  return {
    id: camp.id,
    name: camp.name,
    start: camp.startTimestamp,
    end: camp.endTimestamp,
    groupUid: camp.seasonUid || camp.leaderboardGroupUid, // either is fine for PB
    mapUids: (camp.playlist || []).map(p => p.mapUid)
  };
}

// Get WR (top 1 world) for a single mapUid
// Docs: GET /api/token/leaderboard/group/{groupUid}/map/{mapUid}/top?onlyWorld=true&length=1
// groupUid=Personal_Best → global leaderboard
// https://webservices.openplanet.dev/live/leaderboards/top
async function getMapWR(accessToken, mapUid) {
  const groupUid = "Personal_Best";
  const url = `${LIVE_BASE}/api/token/leaderboard/group/${groupUid}/map/${mapUid}/top?onlyWorld=true&length=1`;
  const r = await fetch(url, {
    headers: {
      "Authorization": `nadeo_v1 t=${accessToken}`,
      "User-Agent": "trackmaniaevents.com/1.0 (Render)"
    }
  });
  if (!r.ok) {
    return { mapUid, error: `leaderboard ${r.status}` };
  }
  const j = await r.json();
  const top = j?.tops?.[0]?.top?.[0]; // first world entry
  if (!top) return { mapUid, empty: true };
  // score is time in milliseconds; timestamp when record set (per docs)
  return {
    mapUid,
    accountId: top.accountId,
    timeMs: top.score,
    timestamp: top.timestamp
  };
}

// -- tiny in-memory cache so we don’t hammer the API --
let wrCache = { ts: 0, data: null };
const WR_TTL_MS = 60 * 1000; // 60s cache

// ---------- Public route: world-record leaderboard ----------
app.get("/api/wr-leaderboard", async (_req, res) => {
  try {
    // serve from cache if fresh
    const now = Date.now();
    if (wrCache.data && now - wrCache.ts < WR_TTL_MS) {
      return res.json(wrCache.data);
    }

    const access = await getLiveAccessToken();
    const campaign = await getCurrentCampaign(access);
    // Limit concurrency to be polite
    const limit = 6;
    const chunks = [];
    for (let i = 0; i < campaign.mapUids.length; i += limit) {
      chunks.push(campaign.mapUids.slice(i, i + limit));
    }
    const results = [];
    for (const batch of chunks) {
      const part = await Promise.all(batch.map(uid => getMapWR(access, uid)));
      results.push(...part);
    }

    const payload = {
      campaign: {
        id: campaign.id,
        name: campaign.name,
        start: campaign.start,
        end: campaign.end
      },
      rows: results,       // [{mapUid, accountId, timeMs, timestamp}]
      fetchedAt: now
    };

    wrCache = { ts: now, data: payload };
    res.json(payload);
  } catch (err) {
    console.error("WR leaderboard error:", err);
    res.status(500).json({ error: String(err?.message || err) });
  }
});

// --- Start server (Render) ---
const PORT = process.env.PORT || 3000;
app.listen(PORT, "0.0.0.0", () => console.log(`✅ API running on port ${PORT}`));
