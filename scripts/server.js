import express from "express";
import fetch from "node-fetch";

/**
 * ENV you must set on Render:
 *   REFRESH_TOKEN = <your Nadeo refresh token (audience: NadeoLiveServices)>
 *
 * Optional:
 *   CORS_ORIGINS = comma-separated origins allowed to call this API
 *                  (default allows https://trackmaniaevents.com and localhost:5500)
 */

const app = express();

// ---------- CORS ----------
const DEFAULT_ORIGINS = new Set([
  "https://trackmaniaevents.com",
  "http://localhost:5500",
  "http://127.0.0.1:5500"
]);
const ENV_ORIGINS = (process.env.CORS_ORIGINS || "")
  .split(",")
  .map(s => s.trim())
  .filter(Boolean);
const ALLOW = new Set([...DEFAULT_ORIGINS, ...ENV_ORIGINS]);

app.use((req, res, next) => {
  const o = req.headers.origin;
  if (o && ALLOW.has(o)) res.setHeader("Access-Control-Allow-Origin", o);
  res.setHeader("Vary", "Origin");
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
  if (req.method === "OPTIONS") return res.sendStatus(200);
  next();
});

// ---------- Health ----------
app.get("/", (_req, res) => res.send("OK"));
app.get("/healthz", (_req, res) => res.json({ ok: true }));
app.get("/api/ping", (_req, res) => res.json({ ok: true, ts: Date.now() }));

// ---------- Nadeo Auth: refresh -> access ----------
const NADEO_REFRESH = process.env.REFRESH_TOKEN;
const CORE_REFRESH_URL = "https://prod.trackmania.core.nadeo.online/v2/authentication/token/refresh";

let cachedAccess = { token: null, expAt: 0 };

async function getLiveAccessToken() {
  const now = Date.now();
  if (cachedAccess.token && now < cachedAccess.expAt - 30_000) return cachedAccess.token;
  if (!NADEO_REFRESH) throw new Error("Missing REFRESH_TOKEN env var");

  const r = await fetch(CORE_REFRESH_URL, {
    method: "POST",
    headers: {
      "Authorization": `nadeo_v1 t=${NADEO_REFRESH}`,
      "Content-Type": "application/json",
      "User-Agent": "trackmaniaevents.com/1.0 (Render)"
    },
    body: "{}"
  });
  if (!r.ok) throw new Error(`refresh failed ${r.status} ${await r.text()}`);
  const j = await r.json();
  const accessToken = j.accessToken || j.access_token;
  const expiresIn = j.expiresIn || j.expires_in || 3600;
  if (!accessToken) throw new Error("no accessToken in refresh response");
  cachedAccess = { token: accessToken, expAt: Date.now() + expiresIn * 1000 };
  return cachedAccess.token;
}

// ---------- Live Services helpers ----------
const LIVE_BASE = "https://live-services.trackmania.nadeo.live";

// Current official campaign (v2)
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
  const c = j?.campaignList?.[0];
  if (!c) throw new Error("no campaign returned");
  return {
    id: c.id,
    name: c.name,
    start: c.startTimestamp,
    end: c.endTimestamp,
    mapUids: (c.playlist || []).map(p => p.mapUid)
  };
}

// World record (top 1 world) for a map
async function getMapWR(accessToken, mapUid) {
  const groupUid = "Personal_Best";
  const url = `${LIVE_BASE}/api/token/leaderboard/group/${groupUid}/map/${mapUid}/top?onlyWorld=true&length=1`;
  const r = await fetch(url, {
    headers: {
      "Authorization": `nadeo_v1 t=${accessToken}`,
      "User-Agent": "trackmaniaevents.com/1.0 (Render)"
    }
  });
  if (!r.ok) return { mapUid, error: `leaderboard ${r.status}` };
  const j = await r.json();
  const top = j?.tops?.[0]?.top?.[0];
  if (!top) return { mapUid, empty: true };
  return {
    mapUid,
    accountId: top.accountId,
    timeMs: top.score,
    timestamp: top.timestamp
  };
}

// ---------- Simple cache to avoid hammering API ----------
let wrCache = { ts: 0, data: null };
const WR_TTL_MS = 60 * 1000;

// ---------- Public route ----------
app.get("/api/wr-leaderboard", async (_req, res) => {
  try {
    const now = Date.now();
    if (wrCache.data && now - wrCache.ts < WR_TTL_MS) {
      return res.json(wrCache.data);
    }

    const access = await getLiveAccessToken();
    const campaign = await getCurrentCampaign(access);

    const mapUids = campaign.mapUids || [];
    const limit = 6; // polite concurrency
    const results = [];
    for (let i = 0; i < mapUids.length; i += limit) {
      const part = await Promise.all(mapUids.slice(i, i + limit).map(uid => getMapWR(access, uid)));
      results.push(...part);
    }

    const payload = {
      campaign: {
        id: campaign.id,
        name: campaign.name,
        start: campaign.start,
        end: campaign.end
      },
      rows: results,           // [{ mapUid, accountId, timeMs, timestamp }]
      fetchedAt: now
    };

    wrCache = { ts: now, data: payload };
    return res.json(payload);
  } catch (err) {
    console.error("WR leaderboard error:", err);
    if (!res.headersSent) {
      return res.status(500).json({
        error: "Failed to load leaderboard",
        detail: err?.message || String(err)
      });
    }
  }
});

// ---------- Start server (Render) ----------
const PORT = process.env.PORT || 3000;
app.listen(PORT, "0.0.0.0", () => console.log(`✅ API running on port ${PORT}`));
