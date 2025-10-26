import express from "express";
import fetch from "node-fetch";
import helmet from "helmet";
import morgan from "morgan";
import cors from "cors";

const app = express();

/* -------------------- Security / Logging -------------------- */
app.use(helmet({
  // let images/iframed assets load cross-origin if you add any later
  crossOriginResourcePolicy: { policy: "cross-origin" }
}));
app.use(morgan("tiny"));

/* -------------------- CORS -------------------- */
const ALLOWED_ORIGINS = [
  "https://trackmaniaevents.com",
  "https://www.trackmaniaevents.com",
  // If you preview on GitHub Pages replace <user> below or add your exact domain:
  "https://<your-gh-pages-username>.github.io",
  // local dev
  "http://localhost:3000",
  "http://localhost:5173",
  "http://localhost:8080"
];

app.use(cors({
  origin: (origin, cb) => {
    if (!origin) return cb(null, true);                    // curl/server-to-server
    if (ALLOWED_ORIGINS.includes(origin)) return cb(null, true);
    return cb(new Error("Not allowed by CORS: " + origin));
  },
  methods: ["GET", "OPTIONS"],
  allowedHeaders: ["Content-Type"],
  maxAge: 86400
}));

// quick preflight for any path
app.options("*", (req, res) => {
  res.set("Access-Control-Allow-Methods", "GET,OPTIONS");
  res.set("Access-Control-Allow-Headers", "Content-Type");
  res.sendStatus(204);
});

app.use(express.json());

/* -------------------- Tiny cache helper -------------------- */
const cache = new Map();
const getCached = (key, ttlMs, fn) => {
  const now = Date.now();
  const hit = cache.get(key);
  if (hit && now - hit.t <= ttlMs) return hit.v;
  return Promise.resolve()
    .then(fn)
    .then(v => { cache.set(key, { v, t: now }); return v; });
};

/* -------------------- Trackmania OAuth (display names) -------------------- */
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

/* -------------------- Nadeo Live token (trophies / leaderboards) -------------------- */
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

/* -------------------- Small fetch helper (JSON + error text) -------------------- */
async function fetchJSON(url, opts = {}) {
  const r = await fetch(url, opts);
  if (!r.ok) {
    const txt = await r.text().catch(() => r.statusText);
    const err = new Error(`HTTP ${r.status} ${url}: ${txt.slice(0, 300)}`);
    err.status = r.status;
    throw err;
  }
  const ct = r.headers.get("content-type") || "";
  if (!ct.includes("application/json")) {
    const txt = await r.text().catch(() => "(non-JSON)");
    const err = new Error(`Non-JSON from ${url}: ${txt.slice(0, 300)}`);
    err.status = 502;
    throw err;
  }
  return r.json();
}

/* ==========================================================
   API ROUTES
   ========================================================== */

// Resolve display name <-> accountId
app.get("/api/players/resolve", async (req, res) => {
  res.set("Cache-Control", "no-store");
  try {
    const name = (req.query.name || "").toString().trim();
    const id   = (req.query.id   || "").toString().trim();
    if (!name && !id) return res.status(400).json({ error: "pass ?name= or ?id=" });

    const token = await getCached("tm_access", 15 * 60 * 1000, getTMAccessToken);
    const headers = { Authorization: `Bearer ${token}` };

    if (name) {
      const url = `https://api.trackmania.com/api/display-names/account-ids?displayName[]=${encodeURIComponent(name)}`;
      const j = await fetchJSON(url, { headers });
      return res.json({ accountId: j[name] || null, displayName: name });
    } else {
      const url = `https://api.trackmania.com/api/display-names?accountId[]=${encodeURIComponent(id)}`;
      const j = await fetchJSON(url, { headers });
      return res.json({ accountId: id, displayName: j[id] || null });
    }
  } catch (e) {
    res.status(e.status || 500).json({ error: e.message || "resolve failed" });
  }
});

// Basic profile (displayName, country, zone, avatar placeholder)
app.get("/api/players/basic", async (req, res) => {
  res.set("Cache-Control", "no-store");
  try {
    const id = (req.query.id || "").toString().trim();
    if (!id) return res.status(400).json({ error: "?id=" });

    const token = await getCached("tm_access", 15 * 60 * 1000, getTMAccessToken);
    const headers = { Authorization: `Bearer ${token}` };
    const url = `https://api.trackmania.com/api/display-names?accountId[]=${encodeURIComponent(id)}`;
    const j = await fetchJSON(url, { headers });
    const displayName = j[id] || null;

    res.json({
      accountId: id,
      displayName,
      country: null,
      zone: null,
      avatar: null
    });
  } catch (e) {
    res.status(e.status || 500).json({ error: e.message || "basic failed" });
  }
});

// Trophy points & ranks
app.get("/api/players/trophies", async (req, res) => {
  res.set("Cache-Control", "no-store");
  try {
    const id = (req.query.id || "").toString().trim();
    if (!id) return res.status(400).json({ error: "?id=" });

    const token = await getCached("nadeo_live", 10 * 60 * 1000, getNadeoLiveToken);
    const r = await fetch("https://live-services.trackmania.nadeo.live/api/token/leaderboard/trophy/player", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `nadeo_v1 t=${token}` },
      body: JSON.stringify({ listPlayer: [{ accountId: id }] })
    });
    if (!r.ok) {
      const txt = await r.text().catch(() => r.statusText);
      throw Object.assign(new Error(`trophy fetch failed: ${txt}`), { status: r.status });
    }
    const j = await r.json();

    const p = (j && j.players && j.players[0]) || {};
    res.json({
      points: p.trophyPoints ?? null,
      worldRank: p.zoneRankings?.world?.position ?? null,
      countryRank: p.zoneRankings?.country?.position ?? null,
      regionRank: p.zoneRankings?.region?.position ?? null
    });
  } catch (e) {
    res.status(e.status || 500).json({ error: e.message || "trophies failed" });
  }
});

// Recent records (placeholder logic until you fill MAPS)
const MAPS = []; // TODO: populate with map UIDs you track.
app.get("/api/players/records", async (req, res) => {
  res.set("Cache-Control", "no-store");
  try {
    const id = (req.query.id || "").toString().trim();
    if (!id) return res.status(400).json({ error: "?id=" });

    const token = await getCached("nadeo_live", 10 * 60 * 1000, getNadeoLiveToken);
    const headers = { Authorization: `nadeo_v1 t=${token}` };

    const results = [];
    for (const mapUid of MAPS) {
      const url = `https://live-services.trackmania.nadeo.live/api/token/leaderboard/group/Personal_Best/map/${mapUid}/top?onlyWorld=true&length=100`;
      try {
        const j = await fetchJSON(url, { headers });
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
      } catch (e) {
        // don’t fail the whole request if one map errors
      }
    }

    res.json({ entries: results.slice(0, 50) });
  } catch (e) {
    res.status(e.status || 500).json({ error: e.message || "records failed" });
  }
});

/* -------------------- Health & Ping -------------------- */
app.get("/api/ping", (_req, res) => res.json({ ok: true, ts: Date.now() }));
app.get("/healthz", (_req, res) => res.json({ ok: true }));

/* -------------------- Error fallback -------------------- */
app.use((err, _req, res, _next) => {
  const code = err.status || 500;
  res.status(code).json({ error: err.message || "server error" });
});

/* -------------------- Start -------------------- */
const PORT = process.env.PORT || 3001;
app.listen(PORT, () => console.log(`✅ API listening on :${PORT}`));
