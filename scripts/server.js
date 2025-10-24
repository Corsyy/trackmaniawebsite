import express from "express";
import fetch from "node-fetch";

/**
 * ENV on Render:
 *   REFRESH_TOKEN = <NadeoLiveServices refresh token>
 * Optional:
 *   CORS_ORIGINS = comma-separated list of extra origins
 */

const app = express();

/* --------------------------- CORS --------------------------- */
const DEFAULT_ORIGINS = new Set([
  "https://trackmaniaevents.com",
  "http://localhost:5500",
  "http://127.0.0.1:5500",
]);
const EXTRA = (process.env.CORS_ORIGINS || "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);
const ALLOW = new Set([...DEFAULT_ORIGINS, ...EXTRA]);

app.use((req, res, next) => {
  const o = req.headers.origin;
  if (o && ALLOW.has(o)) res.setHeader("Access-Control-Allow-Origin", o);
  res.setHeader("Vary", "Origin");
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
  if (req.method === "OPTIONS") return res.sendStatus(200);
  next();
});

/* ------------------------- Health -------------------------- */
app.get("/", (_req, res) => res.send("OK"));
app.get("/healthz", (_req, res) => res.json({ ok: true }));
app.get("/api/ping", (_req, res) => res.json({ ok: true, ts: Date.now() }));

/* -------------------- Auth (refresh -> access) -------------- */
const NADEO_REFRESH = process.env.REFRESH_TOKEN;
const CORE_REFRESH_URL =
  "https://prod.trackmania.core.nadeo.online/v2/authentication/token/refresh";
let cachedAccess = { token: null, expAt: 0 };

async function getLiveAccessToken() {
  const now = Date.now();
  if (cachedAccess.token && now < cachedAccess.expAt - 30_000)
    return cachedAccess.token;
  if (!NADEO_REFRESH) throw new Error("Missing REFRESH_TOKEN");

  const r = await fetch(CORE_REFRESH_URL, {
    method: "POST",
    headers: {
      Authorization: `nadeo_v1 t=${NADEO_REFRESH}`,
      "Content-Type": "application/json",
      "User-Agent": "trackmaniaevents.com/1.0 (Render)",
    },
    body: "{}",
  });
  if (!r.ok) throw new Error(`refresh failed ${r.status} ${await r.text()}`);
  const j = await r.json();
  const accessToken = j.accessToken || j.access_token;
  const expiresIn = j.expiresIn || j.expires_in || 3600;
  if (!accessToken) throw new Error("no accessToken in refresh response");
  cachedAccess = { token: accessToken, expAt: Date.now() + expiresIn * 1000 };
  return cachedAccess.token;
}

/* ------------------ HTTP / JSON helpers ------------------ */
function isJsonResponse(r) {
  const ct = (r.headers?.get?.("content-type") || "").toLowerCase();
  return ct.includes("application/json");
}
async function safeJson(r, label = "response") {
  if (!r.ok) throw new Error(`${label} ${r.status}`);
  if (!isJsonResponse(r)) throw new Error(`${label} is not JSON (${r.status})`);
  return r.json();
}

/* ------------------ Live Services helpers ------------------ */
const LIVE_BASE = "https://live-services.trackmania.nadeo.live";

async function jget(url, accessToken) {
  const r = await fetch(url, {
    headers: {
      Authorization: `nadeo_v1 t=${accessToken}`,
      "User-Agent": "trackmaniaevents.com/1.0 (Render)",
      Accept: "application/json",
    },
  });
  if (!r.ok) throw new Error(`${url} -> ${r.status}`);
  return r.json();
}

// Official campaigns (many)
async function getAllOfficialCampaigns(accessToken) {
  const url = `${LIVE_BASE}/api/campaign/official?offset=0&length=200`;
  const j = await jget(url, accessToken);
  return j?.campaignList || [];
}

/**
 * TOTD seasons (many).
 * NOTE: Some environments return 404 for these endpoints.
 * We try both token & non-token; if both fail, we proceed WITHOUT TOTD.
 */
async function getAllTotdSeasons(accessToken) {
  const candidates = [
    `${LIVE_BASE}/api/token/totd/season?offset=0&length=200`,
    `${LIVE_BASE}/api/totd/season?offset=0&length=200`,
  ];
  for (const url of candidates) {
    try {
      const j = await jget(url, accessToken);
      return j?.seasonList || [];
    } catch (e) {
      console.warn("TOTD season fetch failed for", url, "-", e.message);
    }
  }
  console.warn("TOTD season endpoints unavailable; proceeding without TOTD.");
  return [];
}

// Extract mapUids from both sets
function collectAllMapUids(officialCampaigns, totdSeasons) {
  const officialUids = officialCampaigns.flatMap((c) =>
    (c.playlist || []).map((p) => p.mapUid)
  );
  const totdUids = totdSeasons.flatMap((s) =>
    (s.days || []).map((d) => d.mapUid)
  );
  return {
    officialUids: Array.from(new Set(officialUids)),
    totdUids: Array.from(new Set(totdUids)),
    allUids: Array.from(new Set([...officialUids, ...totdUids])),
  };
}

// Normalize leaderboard timestamps to seconds since epoch
function normalizeToSeconds(val) {
  if (val == null) return 0;
  let n = Number(val);
  if (Number.isFinite(n)) {
    if (n > 1e12) return Math.round(n / 1000); // ms -> s
    return Math.round(n);
  }
  const parsed = Date.parse(String(val));
  if (Number.isFinite(parsed)) {
    return parsed > 1e12 ? Math.round(parsed / 1000) : Math.round(parsed);
  }
  return 0;
}

// WR (top1 world) per map
async function getMapWR(accessToken, mapUid) {
  const groupUid = "Personal_Best";
  const url = `${LIVE_BASE}/api/token/leaderboard/group/${groupUid}/map/${mapUid}/top?onlyWorld=true&length=1`;
  try {
    const j = await jget(url, accessToken);
    const top = j?.tops?.[0]?.top?.[0];
    if (!top) return { mapUid, empty: true };
    return {
      mapUid,
      accountId: top.accountId,
      timeMs: top.score,
      timestamp: normalizeToSeconds(top.timestamp),
    };
  } catch (e) {
    return { mapUid, error: e.message || "leaderboard fetch failed" };
  }
}

/* ---------------------- Display names ---------------------- */
// Process-wide cache so we only resolve each accountId once.
const nameCache = new Map(); // accountId -> displayName

// Nadeo batch resolver (several shapes tried)
async function resolveViaNadeo(accessToken, ids) {
  const out = new Map();
  if (!ids?.length) return out;

  const HJSON = {
    Authorization: `nadeo_v1 t=${accessToken}`,
    "Content-Type": "application/json",
    Accept: "application/json",
    "User-Agent": "trackmaniaevents.com/1.0 (Render)",
  };
  const HGET = {
    Authorization: `nadeo_v1 t=${accessToken}`,
    Accept: "application/json",
    "User-Agent": "trackmaniaevents.com/1.0 (Render)",
  };

  const harvest = (j) => {
    const arr = (j && (j.displayNames || j)) || [];
    for (const row of arr) {
      const id = row?.accountId;
      const dn =
        row?.displayName || row?.name || row?.userName || row?.username;
      if (id && dn) out.set(id, dn);
    }
  };

  async function tryBatchGET_rawComma(batch) {
    const url = `${LIVE_BASE}/api/token/accounts/displayNames?accountIdList=${batch.join(
      ","
    )}`;
    const r = await fetch(url, { headers: HGET });
    if (!r.ok) throw new Error(`GET rawComma ${r.status}`);
    const j = await r.json();
    harvest(j);
  }
  async function tryBatchGET_encoded(batch) {
    const url = `${LIVE_BASE}/api/token/accounts/displayNames?accountIdList=${encodeURIComponent(
      batch.join(",")
    )}`;
    const r = await fetch(url, { headers: HGET });
    if (!r.ok) throw new Error(`GET encoded ${r.status}`);
    const j = await r.json();
    harvest(j);
  }
  async function tryBatchGET_legacy(batch) {
    const url = `${LIVE_BASE}/api/accounts/displayNames?accountIdList=${batch.join(
      ","
    )}`;
    const r = await fetch(url, { headers: HGET });
    if (!r.ok) throw new Error(`GET legacy ${r.status}`);
    const j = await r.json();
    harvest(j);
  }
  async function tryBatchPOST_array(batch) {
    const url = `${LIVE_BASE}/api/token/accounts/displayNames`;
    const r = await fetch(url, {
      method: "POST",
      headers: HJSON,
      body: JSON.stringify({ accountIdList: batch }),
    });
    if (!r.ok) throw new Error(`POST array ${r.status}`);
    const j = await r.json();
    harvest(j);
  }
  async function tryBatchPOST_csv(batch) {
    const url = `${LIVE_BASE}/api/token/accounts/displayNames`;
    const r = await fetch(url, {
      method: "POST",
      headers: HJSON,
      body: JSON.stringify({ accountIdList: batch.join(",") }),
    });
    if (!r.ok) throw new Error(`POST csv ${r.status}`);
    const j = await r.json();
    harvest(j);
  }

  const CHUNK = 100;
  for (let i = 0; i < ids.length; i += CHUNK) {
    const batch = ids.slice(i, i + CHUNK);

    const attempts = [
      tryBatchGET_rawComma,
      tryBatchGET_encoded,
      tryBatchPOST_array,
      tryBatchPOST_csv,
      tryBatchGET_legacy,
    ];
    for (const fn of attempts) {
      try {
        await fn(batch);
        // Keep trying remaining attempts—sometimes one shape returns more than another
      } catch (e) {
        // swallow & continue to other shapes
      }
    }
  }
  return out;
}

// trackmania.io fallback (tolerant to HTML / non-JSON)
const TMIO_BASE = "https://trackmania.io/api";
async function resolveViaTMIO(ids) {
  const out = new Map();
  if (!ids?.length) return out;

  const harvest = (rows) => {
    for (const row of rows || []) {
      const id = row?.accountId;
      const dn =
        row?.displayName || row?.name || row?.userName || row?.username;
      if (id && dn) out.set(id, dn);
    }
  };

  // Try POST first (short body, avoids long URLs/431)
  const POST_CHUNK = 80;
  for (let i = 0; i < ids.length; i += POST_CHUNK) {
    const batch = ids.slice(i, i + POST_CHUNK);
    try {
      const r = await fetch(`${TMIO_BASE}/accounts/displayNames`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Accept: "application/json",
          "User-Agent": "trackmaniaevents.com/1.0 (Render)",
        },
        body: JSON.stringify({ accountIds: batch }),
      });
      const j = await safeJson(r, "TMIO POST");
      harvest(j);
      continue;
    } catch (e) {
      console.warn("TMIO POST skipped:", e.message);
    }

    // GET fallback in small chunks; skip non-JSON quietly
    const GET_CHUNK = 20;
    for (let k = 0; k < batch.length; k += GET_CHUNK) {
      const mini = batch.slice(k, k + GET_CHUNK);
      const url = `${TMIO_BASE}/accounts/displayNames?accountIds=${encodeURIComponent(
        mini.join(",")
      )}`;
      try {
        const r = await fetch(url, {
          headers: {
            Accept: "application/json",
            "User-Agent": "trackmaniaevents.com/1.0 (Render)",
          },
        });
        if (!r.ok || !isJsonResponse(r)) {
          console.warn(
            `TMIO GET skipped: ${r.status}${!isJsonResponse(r) ? " (non-JSON)" : ""
            }`
          );
          continue;
        }
        const j = await r.json();
        harvest(j);
      } catch (e) {
        console.warn("TMIO GET skipped:", e.message);
      }
    }
  }
  return out;
}

// Unified resolver that fills the global nameCache
async function resolveDisplayNames(accessToken, ids) {
  const all = Array.from(new Set((ids || []).filter(Boolean)));
  const need = all.filter((id) => !nameCache.has(id));
  if (!need.length) return nameCache;

  // 1) Nadeo
  try {
    const nadeo = await resolveViaNadeo(accessToken, need);
    for (const [k, v] of nadeo) nameCache.set(k, v);
  } catch (e) {
    console.warn("Nadeo name resolution failed:", e.message);
  }

  // 2) TMIO fallback for any still-missing
  const missing = need.filter((id) => !nameCache.has(id));
  if (missing.length) {
    try {
      const tmio = await resolveViaTMIO(missing);
      for (const [k, v] of tmio) nameCache.set(k, v);
    } catch (e) {
      console.warn("TMIO fallback failed:", e.message);
    }
  }

  // 3) Ensure everything has at least the id
  for (const id of need) if (!nameCache.has(id)) nameCache.set(id, id);

  return nameCache;
}

/* ------------------------- Cache --------------------------- */
let wrCache = { ts: 0, rows: [], counts: { official: 0, totd: 0 } };
const WR_TTL_MS = 10 * 60 * 1000; // 10 min
const CONCURRENCY = 8;
/* --------------- Build ALL WRs (official + TOTD) ----------- */
async function buildAllWRs() {
  const access = await getLiveAccessToken();
  const [official, totd] = await Promise.all([
    getAllOfficialCampaigns(access),
    getAllTotdSeasons(access),
  ]);

  const { officialUids, totdUids, allUids } = collectAllMapUids(
    official,
    totd
  );

  const wrs = [];
  // polite concurrency
  for (let i = 0; i < allUids.length; i += CONCURRENCY) {
    const part = await Promise.all(
      allUids.slice(i, i + CONCURRENCY).map((uid) => getMapWR(access, uid))
    );
    wrs.push(
      ...part
        .filter(Boolean)
        .map((r) => ({
          ...r,
          sourceType: officialUids.includes(r.mapUid)
            ? "official"
            : totdUids.includes(r.mapUid)
            ? "totd"
            : "unknown",
        }))
    );
  }

  // resolve names
  const idList = wrs.map((r) => r.accountId).filter(Boolean);
  await resolveDisplayNames(access, idList);
  for (const r of wrs) {
    if (r.accountId) r.displayName = nameCache.get(r.accountId) || r.accountId;
  }

  // newest first
  wrs.sort((a, b) => (b.timestamp || 0) - (a.timestamp || 0));

  wrCache = {
    ts: Date.now(),
    rows: wrs,
    counts: {
      official: wrs.filter((r) => r.sourceType === "official").length,
      totd: wrs.filter((r) => r.sourceType === "totd").length,
    },
  };
  return wrs;
}

/* ------------------------ Endpoints ------------------------ */

// Most recent WRs across ALL official campaigns + ALL TOTD seasons
// Optional: ?limit=300  ?search=foo  ?source=official|totd
app.get("/api/wr-latest", async (req, res) => {
  try {
    const fresh = Date.now() - wrCache.ts < WR_TTL_MS && wrCache.rows.length;
    const rows = fresh ? wrCache.rows : await buildAllWRs();

    let out = rows;
    const limit = Math.max(1, Math.min(2000, Number(req.query.limit) || 300));

    const src = (req.query.source || "").toString().trim().toLowerCase();
    if (src === "official" || src === "totd") {
      out = out.filter((r) => r.sourceType === src);
    }

    const search = (req.query.search || "").toString().trim().toLowerCase();
    if (search) {
      out = out.filter(
        (r) =>
          r.displayName?.toLowerCase().includes(search) ||
          r.accountId?.toLowerCase().includes(search) ||
          r.mapUid?.toLowerCase().includes(search)
      );
    }

    res.json({
      rows: out.slice(0, limit),
      total: out.length,
      fetchedAt: wrCache.ts,
      counts: wrCache.counts, // {official, totd}
    });
  } catch (err) {
    console.error("wr-latest:", err);
    if (!res.headersSent)
      res.status(500).json({
        error: "Failed to load latest world records",
        detail: err?.message || String(err),
      });
  }
});

// Players leaderboard across ALL official + TOTD WRs
// Optional: ?limit=200  ?q=search  ?source=official|totd
app.get("/api/wr-players", async (req, res) => {
  try {
    if (!wrCache.rows.length || Date.now() - wrCache.ts >= WR_TTL_MS) {
      await buildAllWRs();
    }

    let rows = wrCache.rows;
    const src = (req.query.source || "").toString().trim().toLowerCase();
    if (src === "official" || src === "totd") {
      rows = rows.filter((r) => r.sourceType === src);
    }

    const tally = new Map(); // accountId -> { accountId, displayName, wrCount, latestTs }
    for (const r of rows) {
      if (!r.accountId) continue;
      const rec =
        tally.get(r.accountId) || {
          accountId: r.accountId,
          displayName: r.displayName || r.accountId,
          wrCount: 0,
          latestTs: 0,
        };
      rec.wrCount += 1;
      if ((r.timestamp || 0) > rec.latestTs) rec.latestTs = r.timestamp || 0;
      tally.set(r.accountId, rec);
    }

    let list = Array.from(tally.values());
    const q = (req.query.q || "").toString().trim().toLowerCase();
    if (q) {
      list = list.filter(
        (p) =>
          p.displayName?.toLowerCase().includes(q) ||
          p.accountId?.toLowerCase().includes(q)
      );
    }

    list.sort(
      (a, b) => b.wrCount - a.wrCount || b.latestTs - a.latestTs
    );
    const limit = Math.max(1, Math.min(2000, Number(req.query.limit) || 200));
    res.json({
      players: list.slice(0, limit),
      total: list.length,
      fetchedAt: wrCache.ts,
      counts: wrCache.counts,
    });
  } catch (err) {
    console.error("wr-players:", err);
    if (!res.headersSent)
      res.status(500).json({
        error: "Failed to load WR players",
        detail: err?.message || String(err),
      });
  }
});

/* ---------------- Debug helpers (optional) ------------------ */
// Quick check: /api/debug-names?ids=a,b,c
app.get("/api/debug-names", async (req, res) => {
  try {
    const access = await getLiveAccessToken();
    const ids = String(req.query.ids || "")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
    await resolveDisplayNames(access, ids);
    const data = ids.map((id) => ({ id, name: nameCache.get(id) || null }));
    res.json({ data });
  } catch (e) {
    res.status(500).json({ error: e?.message || String(e) });
  }
});

// Show how many UIDs and how many names are resolved
app.get("/api/debug-stats", (_req, res) => {
  const resolved = Array.from(nameCache.values()).filter((v) => !!v && typeof v === "string");
  res.json({
    cacheTime: wrCache.ts,
    rows: wrCache.rows.length,
    counts: wrCache.counts,
    nameCacheSize: nameCache.size,
    resolvedNamesCount: resolved.length,
    unresolvedSample: (wrCache.rows || [])
      .filter((r) => r.accountId && !nameCache.get(r.accountId))
      .slice(0, 10)
      .map((r) => r.accountId),
  });
});

/* ------------------------- Start --------------------------- */
const PORT = process.env.PORT || 3000;
app.listen(PORT, "0.0.0.0", () =>
  console.log(`✅ API running on port ${PORT}`)
);
