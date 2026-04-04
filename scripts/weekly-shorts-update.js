import fs from "node:fs";
import path from "node:path";

const PUBLIC_DIR = process.env.PUBLIC_DIR || ".";
const BASE_DIR = path.join(process.cwd(), PUBLIC_DIR, "data", "weekly-shorts");
const WEEKS_DIR = path.join(BASE_DIR, "weeks");
const GOAT_WEEKS_DIR = path.join(BASE_DIR, "goat-weeks");

const WEEKS_INDEX_PATH = path.join(BASE_DIR, "weeks.json");
const AGG_PATH = path.join(BASE_DIR, "aggregate.json");
const CHANGELOG_PATH = path.join(BASE_DIR, "changelog.json");
const NAME_CACHE_PATH = path.join(BASE_DIR, "name-cache.json");
const WR_STATE_PATH = path.join(BASE_DIR, "wr-state.json");
const POSTWEEK_MAP_STATE_PATH = path.join(BASE_DIR, "postweek-map-state.json");

const GOAT_WEEKS_INDEX_PATH = path.join(BASE_DIR, "goat-weeks.json");
const GOAT_AGG_PATH = path.join(BASE_DIR, "goat-leaderboard.json");

const DEBUG = String(process.env.DEBUG || "0") === "1";
const dlog = (...a) => DEBUG && console.log("[WS]", ...a);

const LIVE_BASE = "https://live-services.trackmania.nadeo.live";

const OAUTH_CLIENT_ID = process.env.CLIENT_ID;
const OAUTH_CLIENT_SECRET = process.env.CLIENT_SECRET;

const WS_START_ISO = String(process.env.WS_START_ISO || "2024-01-01T00:00:00Z").trim();

const WS_MAPS_PER_WEEK = Number(process.env.WS_MAPS_PER_WEEK || 5);
const MAP_TOP_LENGTH = Number(process.env.WS_MAP_TOP_LENGTH || 10);
const POINTS_TOP_LENGTH = Number(process.env.WS_POINTS_TOP_LENGTH || 25);
const SLEEP_MS = Number(process.env.WS_SLEEP_MS || 70);

const WR_BUG_OVERRIDES = {
  "54xEJ7qhTQpgsigg_l3xU35xZ5j": {
    ignorePlayers: ["awi.uwu"],
    ignoreTimeMs: [11480],
  },
};

const STRICT_TRUST_CHECKS = true;
const BUGGED_RATIO_THRESHOLD = 0.5;
const BUGGED_ABSOLUTE_FLOOR_MS = 2500;

const GOAT_POINTS = {
  weekWin: 50,
  second: 15,
  third: 10,
  fourth: 6,
  fifth: 4,
  wr: 25,
};

function isoNow() {
  return new Date().toISOString();
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function ensureDir(p) {
  fs.mkdirSync(p, { recursive: true });
}

function readJson(p, fallback) {
  try {
    return JSON.parse(fs.readFileSync(p, "utf8"));
  } catch {
    return fallback;
  }
}

function writeJson(p, obj) {
  ensureDir(path.dirname(p));
  fs.writeFileSync(p, JSON.stringify(obj, null, 2) + "\n", "utf8");
}

function parseStartMs() {
  const ms = Date.parse(WS_START_ISO);
  if (!Number.isFinite(ms)) throw new Error(`Invalid WS_START_ISO: ${WS_START_ISO}`);
  return ms;
}

function isValidTimeMs(ms) {
  return Number.isFinite(ms) && ms > 0 && ms < 24 * 3600 * 1000;
}

function extractNumber(v) {
  if (typeof v === "number") return v;
  if (typeof v === "string") {
    const n = Number(v.replace(/,/g, ""));
    return Number.isFinite(n) ? n : NaN;
  }
  if (v && typeof v === "object") {
    const keys = ["score", "points", "value", "val", "total", "result", "time", "timeMs", "best", "record"];
    for (const k of keys) {
      if (k in v) {
        const n = extractNumber(v[k]);
        if (Number.isFinite(n)) return n;
      }
    }
  }
  return NaN;
}

function formatTimeMs(ms) {
  if (!Number.isFinite(ms)) return "unknown time";

  const totalMs = Math.round(ms);
  const minutes = Math.floor(totalMs / 60000);
  const seconds = Math.floor((totalMs % 60000) / 1000);
  const millis = totalMs % 1000;

  if (minutes > 0) {
    return `${minutes}:${String(seconds).padStart(2, "0")}.${String(millis).padStart(3, "0")}`;
  }

  return `${seconds}.${String(millis).padStart(3, "0")}s`;
}

async function fetchRetry(url, opts = {}, retries = 5, baseDelay = 400) {
  let lastErr;
  for (let i = 0; i <= retries; i++) {
    try {
      const r = await fetch(url, opts);
      if (r.status === 429 || (r.status >= 500 && r.status <= 599)) {
        const wait = Math.min(baseDelay * Math.pow(2, i), 8000);
        await sleep(wait);
        continue;
      }
      return r;
    } catch (e) {
      lastErr = e;
      const wait = Math.min(baseDelay * Math.pow(2, i), 8000);
      await sleep(wait);
    }
  }
  throw lastErr || new Error(`fetch failed for ${url}`);
}

// ---------- LIVE SERVICES AUTH ----------

let cachedLive = { token: null, expAt: 0 };

async function getLiveAccessToken() {
  const now = Date.now();
  if (cachedLive.token && now < cachedLive.expAt - 30_000) return cachedLive.token;

  const refreshToken = String(process.env.REFRESH_TOKEN || "").trim();
  if (!refreshToken) {
    throw new Error("REFRESH_TOKEN environment variable missing");
  }

  const res = await fetchRetry(
    "https://prod.trackmania.core.nadeo.online/v2/authentication/token/refresh",
    {
      method: "POST",
      headers: {
        Authorization: `nadeo_v1 t=${refreshToken}`,
        "User-Agent": "trackmaniaevents.com/weekly-shorts (github action)",
        Accept: "application/json",
      },
    }
  );

  if (!res.ok) {
    const txt = await res.text().catch(() => "");
    throw new Error(`refresh token failed ${res.status} ${txt}`);
  }

  const data = await res.json();

  const accessToken = data?.accessToken || null;
  const newRefreshToken = data?.refreshToken || null;

  if (!accessToken) {
    throw new Error("refresh response missing accessToken");
  }

  try {
    const payload = JSON.parse(
      Buffer.from(accessToken.split(".")[1], "base64url").toString("utf8")
    );
    cachedLive = {
      token: accessToken,
      expAt: Number(payload?.exp || 0) * 1000 || Date.now() + 55 * 60 * 1000,
    };
  } catch {
    cachedLive = {
      token: accessToken,
      expAt: Date.now() + 55 * 60 * 1000,
    };
  }

  if (newRefreshToken && process.env.GITHUB_OUTPUT) {
    fs.appendFileSync(
      process.env.GITHUB_OUTPUT,
      `new_refresh_token=${newRefreshToken}\n`,
      "utf8"
    );
  }

  return accessToken;
}

async function jget(url, access) {
  const r = await fetchRetry(url, {
    headers: {
      Authorization: `nadeo_v1 t=${access}`,
      Accept: "application/json",
      "User-Agent": "trackmaniaevents.com/weekly-shorts (github action)",
    },
  });
  if (!r.ok) throw new Error(`${url} -> ${r.status}`);
  return r.json();
}

// ---------- Trackmania OAuth (display names) ----------

let cachedOAuth = { token: null, expAt: 0 };

async function getOAuthToken() {
  const now = Date.now();
  if (cachedOAuth.token && now < cachedOAuth.expAt - 30_000) return cachedOAuth.token;

  if (!OAUTH_CLIENT_ID || !OAUTH_CLIENT_SECRET) {
    throw new Error("Missing CLIENT_ID / CLIENT_SECRET env (Trackmania OAuth).");
  }

  const r = await fetchRetry("https://api.trackmania.com/api/access_token", {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      "User-Agent": "trackmaniaevents.com/weekly-shorts (github action)",
    },
    body: new URLSearchParams({
      grant_type: "client_credentials",
      client_id: OAUTH_CLIENT_ID,
      client_secret: OAUTH_CLIENT_SECRET,
    }).toString(),
  });

  if (!r.ok) throw new Error(`oauth token failed ${r.status} ${await r.text().catch(() => "")}`);

  const j = await r.json();
  const accessToken = j.access_token || j.accessToken;
  const expiresIn = j.expires_in || 3600;
  if (!accessToken) throw new Error("no OAuth access_token");

  cachedOAuth = { token: accessToken, expAt: Date.now() + expiresIn * 1000 };
  return cachedOAuth.token;
}

async function resolveDisplayNames(nameCacheObj, ids, { forceRefresh = false } = {}) {
  const all = Array.from(new Set((ids || []).filter(Boolean)));
  const targets = forceRefresh ? all : all.filter((id) => !nameCacheObj[id]);
  if (!targets.length) return nameCacheObj;

  const token = await getOAuthToken();
  const CHUNK = 50;

  for (let i = 0; i < targets.length; i += CHUNK) {
    const batch = targets.slice(i, i + CHUNK);
    const params = new URLSearchParams();
    for (const id of batch) params.append("accountId[]", id);

    try {
      const r = await fetchRetry(`https://api.trackmania.com/api/display-names?${params.toString()}`, {
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: "application/json",
          "User-Agent": "trackmaniaevents.com/weekly-shorts (github action)",
        },
      });

      if (!r.ok) {
        for (const id of batch) {
          if (!nameCacheObj[id]) nameCacheObj[id] = id;
        }
      } else {
        const j = await r.json();
        for (const id of batch) {
          const dn = j?.[id];
          nameCacheObj[id] = typeof dn === "string" && dn ? dn : (nameCacheObj[id] || id);
        }
      }
    } catch {
      for (const id of batch) {
        if (!nameCacheObj[id]) nameCacheObj[id] = id;
      }
    }

    await sleep(40);
  }

  return nameCacheObj;
}

function collectAccountIdsFromWeekJson(weekJson) {
  const ids = [];

  for (const e of weekJson?.entries || []) {
    if (e?.accountId) ids.push(e.accountId);
  }

  for (const m of weekJson?.maps || []) {
    for (const e of m?.entries || []) {
      if (e?.accountId) ids.push(e.accountId);
    }
  }

  return Array.from(new Set(ids));
}

function applyLatestNamesToWeekJson(weekJson, nameCacheObj) {
  if (!weekJson || typeof weekJson !== "object") return weekJson;

  if (Array.isArray(weekJson.entries)) {
    for (const e of weekJson.entries) {
      if (e?.accountId) e.player = nameCacheObj[e.accountId] || e.player || e.accountId;
    }
  }

  if (Array.isArray(weekJson.maps)) {
    for (const m of weekJson.maps) {
      if (!Array.isArray(m?.entries)) continue;
      for (const e of m.entries) {
        if (e?.accountId) e.player = nameCacheObj[e.accountId] || e.player || e.accountId;
      }
      if (Array.isArray(m?.dropped)) {
        for (const d of m.dropped) {
          if (d?.entry?.accountId) {
            d.entry.player = nameCacheObj[d.entry.accountId] || d.entry.player || d.entry.accountId;
          }
        }
      }
    }
  }

  return weekJson;
}

// ---------- Weekly Shorts discovery ----------

async function fetchWeeklyShortsCampaignWeeks(access) {
  const out = [];
  const LENGTH = 100;

  for (let offset = 0; offset <= 5000; offset += LENGTH) {
    const url = `${LIVE_BASE}/api/campaign/weekly-shorts?length=${LENGTH}&offset=${offset}`;
    const j = await jget(url, access);
    const list = Array.isArray(j?.campaignList) ? j.campaignList : [];
    if (!list.length) break;
    out.push(...list);
    if (list.length < LENGTH) break;
    await sleep(60);
  }

  return out;
}

function buildWeeksIndexFromWeeklyShortsFeed(weeksRaw) {
  const startMs = parseStartMs();

  const normalized = (weeksRaw || [])
    .map((w) => {
      const startTs = Number(w?.startTimestamp) || 0;
      const endTs = Number(w?.endTimestamp) || 0;

      const mapUids = (Array.isArray(w?.playlist) ? w.playlist : [])
        .map((p) => p?.mapUid)
        .filter(Boolean);

      const leaderboardGroupUid =
        w?.seasonUid ||
        w?.leaderboardGroupUid ||
        w?.leaderboardUid ||
        w?.leaderboardGroupId ||
        w?.leaderboardGroup?.uid ||
        w?.leaderboardGroup?.id ||
        w?.campaignLeaderboardGroupUid ||
        w?.leaderboard?.groupUid ||
        w?.leaderboard?.group?.id ||
        w?.uid ||
        w?.id ||
        w?.campaignUid ||
        w?.campaignId ||
        w?.seasonId ||
        null;

      return {
        year: w?.year ?? null,
        wsWeek: w?.week ?? null,
        startTs,
        endTs,
        mapUids,
        leaderboardGroupUid,
      };
    })
    .filter((w) => w.startTs > 0 && w.endTs > 0)
    .filter((w) => w.startTs * 1000 >= startMs)
    .sort((a, b) => a.startTs - b.startTs);

  const weeks = normalized.map((w, idx) => {
    const weekStartIso = new Date(w.startTs * 1000).toISOString();
    const endedAtIso = new Date(w.endTs * 1000 - 1).toISOString();

    return {
      week: idx + 1,
      year: w.year,
      wsWeek: w.wsWeek,
      weekStart: weekStartIso,
      endedAt: endedAtIso,
      leaderboardGroupUid: w.leaderboardGroupUid || null,
      mapUids: (w.mapUids || []).slice(0, WS_MAPS_PER_WEEK),
    };
  });

  return {
    generatedAt: isoNow(),
    startIso: WS_START_ISO,
    mapsPerWeek: WS_MAPS_PER_WEEK,
    weeks,
  };
}

// ---------- Leaderboards ----------

async function fetchWsTop(access, mapUid, length = 10) {
  const url =
    `${LIVE_BASE}/api/token/leaderboard/group/Personal_Best/map/${encodeURIComponent(mapUid)}` +
    `/top?onlyWorld=true&length=${length}&offset=0`;

  const j = await jget(url, access);
  const topArr = Array.isArray(j?.tops?.[0]?.top) ? j.tops[0].top : [];

  return topArr
    .map((x) => {
      const rankRaw = x?.position ?? x?.rank ?? x?.place ?? null;
      const rank = Number(rankRaw);

      const accountId = x?.accountId ?? x?.account_id ?? x?.playerId ?? null;
      if (!accountId) return null;

      const candidates = [
        x?.score,
        x?.time,
        x?.timeMs,
        x?.best,
        x?.record,
        x?.value,
        x?.points,
        x?.sp,
        x?.score?.score,
        x?.score?.time,
        x?.score?.timeMs,
        x?.score?.value,
      ];

      let extracted = NaN;
      for (const c of candidates) {
        const n = extractNumber(c);
        if (Number.isFinite(n)) {
          extracted = n;
          break;
        }
      }

      const timeMs = isValidTimeMs(extracted) ? extracted : null;

      if (!Number.isFinite(rank) || rank <= 0) return null;
      return { rank, accountId, timeMs };
    })
    .filter(Boolean)
    .sort((a, b) => a.rank - b.rank);
}

async function fetchCurrentWR(access, mapUid, nameCacheObj = {}) {
  const rows = await fetchWsTop(access, mapUid, MAP_TOP_LENGTH);
  if (!rows.length) return null;

  const entries = rows.map((r) => ({
    rank: r.rank,
    accountId: r.accountId,
    player: nameCacheObj[r.accountId] || r.accountId,
    timeMs: r.timeMs,
  }));

  const cleaned = cleanMapEntries(mapUid, entries);
  const best = cleaned.entriesClean[0] || null;
  if (!best) return null;

  return {
    rank: best.rawRank ?? best.rank ?? 1,
    accountId: best.accountId,
    timeMs: best.timeMs,
  };
}

async function fetchCurrentPostweekMapEntries(access, mapUid, nameCacheObj = {}) {
  const rows = await fetchWsTop(access, mapUid, MAP_TOP_LENGTH);
  if (!rows.length) return [];

  await resolveDisplayNames(
    nameCacheObj,
    rows.map((r) => r.accountId),
    { forceRefresh: true }
  );

  const entries = rows.map((r) => ({
    rank: r.rank,
    accountId: r.accountId,
    player: nameCacheObj[r.accountId] || r.accountId,
    timeMs: r.timeMs,
  }));

  const cleaned = cleanMapEntries(mapUid, entries);

  return cleaned.entriesClean.map((e, idx) => ({
    rank: idx + 1,
    rawRank: e.rank,
    accountId: e.accountId || null,
    player: e.player,
    timeMs: e.timeMs,
  }));
}

async function fetchWsWeekPointsTop(access, leaderboardGroupUid, length = 10) {
  if (!leaderboardGroupUid) return [];

  const url =
    `${LIVE_BASE}/api/token/leaderboard/group/${encodeURIComponent(leaderboardGroupUid)}` +
    `/top?onlyWorld=true&offset=0&length=${length}`;

  const j = await jget(url, access);
  const arr = Array.isArray(j?.tops?.[0]?.top) ? j.tops[0].top : [];

  const rows = arr
    .map((x) => {
      const accountId = x?.accountId;
      const raw = x?.sp ?? x?.score;
      let score = extractNumber(raw);
      if (!Number.isFinite(score)) score = 0;
      if (!accountId) return null;
      return { accountId, score };
    })
    .filter(Boolean);

  rows.sort((a, b) => b.score - a.score);

  return rows.map((r, idx) => ({
    rank: idx + 1,
    accountId: r.accountId,
    score: r.score,
  }));
}

function cleanMapEntries(mapUid, entriesIn) {
  const entries = Array.isArray(entriesIn) ? entriesIn.slice() : [];
  entries.sort((a, b) => Number(a.rank) - Number(b.rank));

  const dropped = [];

  const ov = WR_BUG_OVERRIDES[mapUid];
  let cleaned = entries.filter((e) => {
    const player = String(e?.player || "");
    const timeMs = e?.timeMs;

    const hitPlayer = ov?.ignorePlayers?.includes(player) || false;
    const hitTime = ov?.ignoreTimeMs?.includes(timeMs) || false;

    const hit = Boolean(hitPlayer || hitTime);
    if (hit) dropped.push({ reason: "override", entry: e });
    return !hit;
  });

  cleaned.sort((a, b) => Number(a.rank) - Number(b.rank));

  const rank1 = cleaned.find((e) => Number(e.rank) === 1) || cleaned[0] || null;
  const rank2 = cleaned.find((e) => Number(e.rank) === 2) || cleaned[1] || null;

  if (
    rank1 &&
    rank2 &&
    isValidTimeMs(rank1.timeMs) &&
    isValidTimeMs(rank2.timeMs) &&
    (rank1.timeMs < BUGGED_ABSOLUTE_FLOOR_MS || rank1.timeMs < rank2.timeMs * BUGGED_RATIO_THRESHOLD)
  ) {
    dropped.push({ reason: "heuristic_bugged_wr", entry: rank1 });
    cleaned = cleaned.filter((e) => e !== rank1);
    cleaned.sort((a, b) => Number(a.rank) - Number(b.rank));
  }

  let trusted = true;
  if (STRICT_TRUST_CHECKS) {
    const ranks = new Set(cleaned.map((e) => Number(e.rank)));
    const has1 = ranks.has(1);
    const has2 = ranks.has(2);
    trusted = has1 && has2;
  }

  return { entriesClean: cleaned, trusted, dropped };
}

// ---------- Aggregate ----------

function buildAggregate(allWeekJson, nameCacheObj = {}, postweekMapState = { maps: {} }) {
  const by = new Map();

  function getOrCreate(accountId, fallbackPlayer = null) {
    if (!accountId) return null;

    let rec = by.get(accountId);
    if (!rec) {
      rec = {
        accountId,
        player: nameCacheObj[accountId] || fallbackPlayer || accountId,
        wins: 0,
        wrs: 0,
        top5: 0,
        weeksWon: [],
        wrWeeks: [],
        top5Weeks: [],
        aliases: [],
      };
      by.set(accountId, rec);
    }

    const latestName = nameCacheObj[accountId] || fallbackPlayer || rec.player || accountId;

    if (rec.player && latestName && rec.player !== latestName) {
      rec.aliases.push(rec.player);
    }
    if (fallbackPlayer && fallbackPlayer !== latestName) {
      rec.aliases.push(fallbackPlayer);
    }

    rec.player = latestName;
    return rec;
  }

  for (const w of allWeekJson) {
    const weekNum = Number(w.week);

    const points = Array.isArray(w.entries) ? w.entries : [];
    const winner = points.find((p) => Number(p.rank) === 1);

    if (winner?.accountId) {
      const rec = getOrCreate(winner.accountId, winner.player);
      if (rec) {
        rec.wins += 1;
        rec.weeksWon.push(weekNum);
      }
    }

    for (const m of w.maps || []) {
      const mapUid = m.mapUid;
      const mapState = getPostweekMapEntry(postweekMapState, weekNum, mapUid);

      let sourceEntries = [];

      if (Array.isArray(mapState?.entries) && mapState.entries.length) {
        sourceEntries = mapState.entries;
      } else {
        const { entriesClean, trusted } = cleanMapEntries(mapUid, m.entries || []);
        if (!trusted) continue;

        sourceEntries = entriesClean.map((e, idx) => ({
          rank: idx + 1,
          rawRank: e.rawRank ?? e.rank,
          accountId: e.accountId || null,
          player: e.player,
          timeMs: e.timeMs,
        }));
      }

      if (!sourceEntries.length) continue;

      const best = sourceEntries[0] || null;
      if (best?.accountId) {
        const rec = getOrCreate(best.accountId, best.player);
        if (rec) {
          rec.wrs += 1;
          rec.wrWeeks.push({
            week: weekNum,
            mapUid,
            timeMs: best.timeMs,
            rawRank: best.rawRank ?? best.rank,
          });
        }
      }

      for (let i = 0; i < Math.min(5, sourceEntries.length); i++) {
        const e = sourceEntries[i];
        if (!e?.accountId) continue;

        const rec = getOrCreate(e.accountId, e.player);
        if (!rec) continue;

        rec.top5 += 1;
        rec.top5Weeks.push({
          week: weekNum,
          mapUid,
          rank: i + 1,
          timeMs: e.timeMs,
          rawRank: e.rawRank ?? e.rank,
        });
      }
    }
  }

  const players = Array.from(by.values()).map((p) => ({
    ...p,
    weeksWon: Array.from(new Set(p.weeksWon)).sort((a, b) => a - b),
    aliases: Array.from(new Set((p.aliases || []).filter(Boolean))).sort((a, b) =>
      a.localeCompare(b)
    ),
  }));

  players.sort(
    (a, b) =>
      b.wins - a.wins ||
      b.wrs - a.wrs ||
      b.top5 - a.top5 ||
      a.player.localeCompare(b.player)
  );

  return { generatedAt: isoNow(), players };
}

// ---------- GOAT ----------

function goatPlacementPoints(rank) {
  switch (Number(rank)) {
    case 1:
      return GOAT_POINTS.weekWin;
    case 2:
      return GOAT_POINTS.second;
    case 3:
      return GOAT_POINTS.third;
    case 4:
      return GOAT_POINTS.fourth;
    case 5:
      return GOAT_POINTS.fifth;
    default:
      return 0;
  }
}

function getGoatTier(points) {
  if (points >= 750) return { tier: 3, label: "GOAT" };
  if (points >= 500) return { tier: 2, label: "Tier 2" };
  if (points >= 250) return { tier: 1, label: "Tier 1" };
  return { tier: 0, label: "Unranked" };
}

function buildGoatWeekJson(weekJson, nameCacheObj = {}) {
  const by = new Map();

  function getOrCreate(accountId, fallbackPlayer = null) {
    if (!accountId) return null;

    let rec = by.get(accountId);
    if (!rec) {
      rec = {
        accountId,
        player: nameCacheObj[accountId] || fallbackPlayer || accountId,
        points: 0,
        weekWins: 0,
        wrs: 0,
        secondPlaces: 0,
        thirdPlaces: 0,
        fourthPlaces: 0,
        fifthPlaces: 0,
      };
      by.set(accountId, rec);
    }

    rec.player = nameCacheObj[accountId] || fallbackPlayer || rec.player || accountId;
    return rec;
  }

  const placements = [];
  for (const entry of (weekJson.entries || []).slice(0, 5)) {
    const pointsAwarded = goatPlacementPoints(entry.rank);
    if (!entry?.accountId || !pointsAwarded) continue;

    const rec = getOrCreate(entry.accountId, entry.player);
    if (!rec) continue;

    rec.points += pointsAwarded;

    if (entry.rank === 1) rec.weekWins += 1;
    if (entry.rank === 2) rec.secondPlaces += 1;
    if (entry.rank === 3) rec.thirdPlaces += 1;
    if (entry.rank === 4) rec.fourthPlaces += 1;
    if (entry.rank === 5) rec.fifthPlaces += 1;

    placements.push({
      rank: entry.rank,
      accountId: entry.accountId,
      player: rec.player,
      score: entry.score ?? entry.points ?? null,
      goatPoints: pointsAwarded,
    });
  }

  const mapWrs = [];
  for (let i = 0; i < (weekJson.maps || []).length; i++) {
    const map = weekJson.maps[i];
    const best = Array.isArray(map?.entries) && map.entries.length ? map.entries[0] : null;
    if (!best?.accountId) continue;

    const rec = getOrCreate(best.accountId, best.player);
    if (!rec) continue;

    rec.points += GOAT_POINTS.wr;
    rec.wrs += 1;

    mapWrs.push({
      mapIndex: i + 1,
      mapUid: map.mapUid,
      accountId: best.accountId,
      player: rec.player,
      timeMs: best.timeMs ?? null,
      goatPoints: GOAT_POINTS.wr,
    });
  }

  const playerTotals = Array.from(by.values()).sort(
    (a, b) => b.points - a.points || a.player.localeCompare(b.player)
  );

  return {
    week: Number(weekJson.week),
    year: weekJson.year ?? null,
    wsWeek: weekJson.wsWeek ?? null,
    weekStart: weekJson.weekStart || null,
    endedAt: weekJson.endedAt || null,
    finalized: true,
    pointsSystem: {
      weekWin: GOAT_POINTS.weekWin,
      wr: GOAT_POINTS.wr,
      second: GOAT_POINTS.second,
      third: GOAT_POINTS.third,
      fourth: GOAT_POINTS.fourth,
      fifth: GOAT_POINTS.fifth,
    },
    placements,
    mapWrs,
    playerTotals,
  };
}

function buildGoatWeeksIndex(goatWeeks) {
  return {
    generatedAt: isoNow(),
    weeks: goatWeeks
      .map((w) => ({
        week: Number(w.week),
        endedAt: w.endedAt || null,
        finalized: true,
      }))
      .sort((a, b) => a.week - b.week),
  };
}

function buildGoatAggregate(goatWeeks, nameCacheObj = {}) {
  const by = new Map();

  function getOrCreate(accountId, fallbackPlayer = null) {
    if (!accountId) return null;

    let rec = by.get(accountId);
    if (!rec) {
      rec = {
        accountId,
        player: nameCacheObj[accountId] || fallbackPlayer || accountId,
        goatPoints: 0,
        weekWins: 0,
        wrs: 0,
        secondPlaces: 0,
        thirdPlaces: 0,
        fourthPlaces: 0,
        fifthPlaces: 0,
        weeksWon: [],
        wrWeeks: [],
      };
      by.set(accountId, rec);
    }

    rec.player = nameCacheObj[accountId] || fallbackPlayer || rec.player || accountId;
    return rec;
  }

  for (const week of goatWeeks) {
    const weekNum = Number(week.week);

    for (const p of week.placements || []) {
      const rec = getOrCreate(p.accountId, p.player);
      if (!rec) continue;

      rec.goatPoints += Number(p.goatPoints || 0);

      if (p.rank === 1) {
        rec.weekWins += 1;
        rec.weeksWon.push(weekNum);
      }
      if (p.rank === 2) rec.secondPlaces += 1;
      if (p.rank === 3) rec.thirdPlaces += 1;
      if (p.rank === 4) rec.fourthPlaces += 1;
      if (p.rank === 5) rec.fifthPlaces += 1;
    }

    for (const wr of week.mapWrs || []) {
      const rec = getOrCreate(wr.accountId, wr.player);
      if (!rec) continue;

      rec.goatPoints += Number(wr.goatPoints || 0);
      rec.wrs += 1;
      rec.wrWeeks.push({
        week: weekNum,
        mapUid: wr.mapUid,
        mapIndex: wr.mapIndex,
        timeMs: wr.timeMs ?? null,
      });
    }
  }

  const players = Array.from(by.values()).map((p) => {
    const tierInfo = getGoatTier(p.goatPoints);
    return {
      ...p,
      tier: tierInfo.tier,
      tierLabel: tierInfo.label,
      qualifiedGoat: p.goatPoints >= 750,
      weeksWon: Array.from(new Set(p.weeksWon)).sort((a, b) => a - b),
    };
  });

  players.sort(
    (a, b) =>
      b.goatPoints - a.goatPoints ||
      b.weekWins - a.weekWins ||
      b.wrs - a.wrs ||
      b.secondPlaces - a.secondPlaces ||
      a.player.localeCompare(b.player)
  );

  return {
    generatedAt: isoNow(),
    minimumGoatPoints: 750,
    tiers: {
      tier1: 250,
      tier2: 500,
      goat: 750,
    },
    pointsSystem: {
      weekWin: GOAT_POINTS.weekWin,
      wr: GOAT_POINTS.wr,
      second: GOAT_POINTS.second,
      third: GOAT_POINTS.third,
      fourth: GOAT_POINTS.fourth,
      fifth: GOAT_POINTS.fifth,
    },
    players,
  };
}

// ---------- CHANGELOG / STATE ----------

function loadChangelog() {
  const existing = readJson(CHANGELOG_PATH, { generatedAt: isoNow(), items: [] });
  if (!existing || typeof existing !== "object") return { generatedAt: isoNow(), items: [] };
  if (!Array.isArray(existing.items)) existing.items = [];
  return existing;
}

function loadWrState() {
  const existing = readJson(WR_STATE_PATH, { generatedAt: isoNow(), maps: {} });
  if (!existing || typeof existing !== "object") return { generatedAt: isoNow(), maps: {} };
  if (!existing.maps || typeof existing.maps !== "object") existing.maps = {};
  return existing;
}

function loadPostweekMapState() {
  const existing = readJson(POSTWEEK_MAP_STATE_PATH, { generatedAt: isoNow(), maps: {} });
  if (!existing || typeof existing !== "object") return { generatedAt: isoNow(), maps: {} };
  if (!existing.maps || typeof existing.maps !== "object") existing.maps = {};
  return existing;
}

function wrStateKey(week, mapUid) {
  return `${week}|${mapUid}`;
}

function getWrStateEntry(wrState, week, mapUid) {
  return wrState.maps[wrStateKey(week, mapUid)] || null;
}

function setWrStateEntry(wrState, week, mapUid, entry) {
  wrState.maps[wrStateKey(week, mapUid)] = {
    week: Number(week),
    mapUid,
    holder: entry.holder || null,
    holderAccountId: entry.holderAccountId || null,
    timeMs: entry.timeMs ?? null,
    updatedAt: isoNow(),
  };
}

function postweekMapKey(week, mapUid) {
  return `${week}|${mapUid}`;
}

function getPostweekMapEntry(postweekMapState, week, mapUid) {
  return postweekMapState.maps[postweekMapKey(week, mapUid)] || null;
}

function setPostweekMapEntry(postweekMapState, week, mapUid, entry) {
  postweekMapState.maps[postweekMapKey(week, mapUid)] = {
    week: Number(week),
    mapUid,
    updatedAt: isoNow(),
    entries: Array.isArray(entry?.entries) ? entry.entries : [],
  };
}

function changelogKey(item) {
  return [
    item.type || "overtake",
    item.week,
    item.mapUid,
    item.oldHolderAccountId || item.oldHolder || "",
    item.newHolderAccountId || item.newHolder || "",
    item.oldTimeMs,
    item.newTimeMs,
  ].join("|");
}

function appendChangelogItem(changelog, item) {
  const keys = new Set(changelog.items.map(changelogKey));
  const key = changelogKey(item);
  if (keys.has(key)) return false;
  changelog.items.unshift(item);
  return true;
}

function getBaselineWRFromWeekFile(weekJson, mapUid) {
  const m = (weekJson.maps || []).find((x) => x.mapUid === mapUid);
  if (!m) return null;

  const { entriesClean, trusted } = cleanMapEntries(mapUid, m.entries || []);
  if (!trusted) return null;
  const best = entriesClean[0] || null;
  if (!best) return null;

  return {
    holder: best.player,
    holderAccountId: best.accountId || null,
    timeMs: best.timeMs,
  };
}

function refreshChangelogNames(changelog, nameCacheObj) {
  if (!Array.isArray(changelog?.items)) return changelog;

  for (const item of changelog.items) {
    if (item?.newHolderAccountId) {
      item.newHolder =
        nameCacheObj[item.newHolderAccountId] ||
        item.newHolder ||
        item.newHolderAccountId;
    }
    if (item?.oldHolderAccountId) {
      item.oldHolder =
        nameCacheObj[item.oldHolderAccountId] ||
        item.oldHolder ||
        item.oldHolderAccountId;
    }

    if (Number.isFinite(item?.week) && Number.isFinite(item?.mapIndex)) {
      if (item.type === "self_improve") {
        item.text =
          `${item.newHolder} has improved their world record on the ${item.mapIndex}${ordinalSuffix(
            item.mapIndex
          )} map of Week ${item.week} from ${formatTimeMs(item.oldTimeMs)} to ${formatTimeMs(item.newTimeMs)}.`;
      } else {
        item.text =
          `${item.newHolder} has overtaken ${item.oldHolder} for the world record on the ${item.mapIndex}${ordinalSuffix(
            item.mapIndex
          )} map of Week ${item.week} with a time of ${formatTimeMs(item.newTimeMs)}.`;
      }
    }
  }

  return changelog;
}

async function main() {
  ensureDir(WEEKS_DIR);
  ensureDir(GOAT_WEEKS_DIR);

  const access = await getLiveAccessToken();
  const weeksRaw = await fetchWeeklyShortsCampaignWeeks(access);
  const weeksIndex = buildWeeksIndexFromWeeklyShortsFeed(weeksRaw);

  const nameCacheObj = readJson(NAME_CACHE_PATH, {});
  const changelog = loadChangelog();
  const wrState = loadWrState();
  const postweekMapState = loadPostweekMapState();
  const allWeekJson = [];
  const goatWeeks = [];

  const nowMs = Date.now();

  for (const w of weeksIndex.weeks || []) {
    const weekPath = path.join(WEEKS_DIR, `${w.week}.json`);
    const endedMs = Date.parse(w.endedAt);
    const isEnded = Number.isFinite(endedMs) && nowMs > endedMs;

    let weekJson = null;

    if (isEnded && fs.existsSync(weekPath)) {
      weekJson = readJson(weekPath, null);

      if (weekJson) {
        const ids = collectAccountIdsFromWeekJson(weekJson);
        await resolveDisplayNames(nameCacheObj, ids, { forceRefresh: true });
        applyLatestNamesToWeekJson(weekJson, nameCacheObj);
        writeJson(weekPath, weekJson);
      }
    }

    if (!weekJson) {
      const maps = [];

      for (const mapUid of w.mapUids || []) {
        const rows = await fetchWsTop(access, mapUid, MAP_TOP_LENGTH);
        await resolveDisplayNames(nameCacheObj, rows.map((r) => r.accountId), { forceRefresh: true });

        const entries = rows.map((r) => ({
          rank: r.rank,
          accountId: r.accountId,
          player: nameCacheObj[r.accountId] || r.accountId,
          timeMs: r.timeMs,
        }));

        const cleaned = cleanMapEntries(mapUid, entries);

        const reRanked = cleaned.entriesClean.map((e, idx) => ({
          rank: idx + 1,
          rawRank: e.rank,
          accountId: e.accountId || null,
          player: e.player,
          timeMs: e.timeMs,
        }));

        maps.push({
          mapUid,
          mapName: null,
          trusted: cleaned.trusted,
          entries: reRanked,
          dropped: DEBUG ? cleaned.dropped : undefined,
        });

        await sleep(SLEEP_MS);
      }

      const pointsRows = await fetchWsWeekPointsTop(access, w.leaderboardGroupUid, POINTS_TOP_LENGTH);
      await resolveDisplayNames(nameCacheObj, pointsRows.map((r) => r.accountId), { forceRefresh: true });

      const pointsEntries = pointsRows.map((r) => {
        const player = nameCacheObj[r.accountId] || r.accountId;
        const n = Number.isFinite(r.score) ? r.score : 0;
        return {
          rank: r.rank,
          accountId: r.accountId,
          player,
          score: n,
          points: n,
          value: n,
          total: n,
          scoreText: String(n),
        };
      });

      weekJson = {
        week: w.week,
        year: w.year,
        wsWeek: w.wsWeek,
        weekStart: w.weekStart,
        endedAt: w.endedAt,
        entries: pointsEntries,
        maps,
        mapUids: w.mapUids || [],
        leaderboardGroupUid: w.leaderboardGroupUid || null,
      };

      writeJson(weekPath, weekJson);
    }

    allWeekJson.push(weekJson);

    if (isEnded) {
      const goatWeekJson = buildGoatWeekJson(weekJson, nameCacheObj);
      goatWeeks.push(goatWeekJson);
      writeJson(path.join(GOAT_WEEKS_DIR, `${w.week}.json`), goatWeekJson);

      for (let i = 0; i < (w.mapUids || []).length; i++) {
        const mapUid = w.mapUids[i];
        const mapIndex = i + 1;

        const currentPostweekEntries = await fetchCurrentPostweekMapEntries(access, mapUid, nameCacheObj);
        if (currentPostweekEntries.length) {
          setPostweekMapEntry(postweekMapState, w.week, mapUid, {
            entries: currentPostweekEntries,
          });
        }

        const baseline = getBaselineWRFromWeekFile(weekJson, mapUid);
        if (!baseline || !isValidTimeMs(baseline.timeMs) || !baseline.holderAccountId) {
          await sleep(SLEEP_MS);
          continue;
        }

        await resolveDisplayNames(nameCacheObj, [baseline.holderAccountId], { forceRefresh: true });
        baseline.holder = nameCacheObj[baseline.holderAccountId] || baseline.holder || baseline.holderAccountId;

        let previous = getWrStateEntry(wrState, w.week, mapUid);

        if (!previous) {
          previous = {
            holder: baseline.holder,
            holderAccountId: baseline.holderAccountId,
            timeMs: baseline.timeMs,
          };

          setWrStateEntry(wrState, w.week, mapUid, previous);
        }

        const current = await fetchCurrentWR(access, mapUid, nameCacheObj);
        if (!current?.accountId || !isValidTimeMs(current?.timeMs)) {
          await sleep(SLEEP_MS);
          continue;
        }

        await resolveDisplayNames(nameCacheObj, [current.accountId], { forceRefresh: true });

        const currentHolder = nameCacheObj[current.accountId] || current.accountId;
        const currentTimeMs = current.timeMs;

        const previousHolderId = previous.holderAccountId || null;
        const previousHolderName =
          (previousHolderId ? nameCacheObj[previousHolderId] : null) ||
          previous.holder ||
          previousHolderId;

        const holderChanged =
          !!previousHolderId &&
          !!current.accountId &&
          current.accountId !== previousHolderId;

        const timeImproved =
          isValidTimeMs(previous.timeMs) &&
          isValidTimeMs(currentTimeMs) &&
          currentTimeMs < previous.timeMs;

        if (timeImproved && !holderChanged) {
          const item = {
            type: "self_improve",
            ts: isoNow(),
            week: Number(w.week),
            mapIndex,
            mapUid,
            newHolder: currentHolder,
            oldHolder: currentHolder,
            newHolderAccountId: current.accountId || null,
            oldHolderAccountId: current.accountId || null,
            newTimeMs: currentTimeMs,
            oldTimeMs: previous.timeMs,
            deltaMs: previous.timeMs - currentTimeMs,
            text: `${currentHolder} has improved their world record on the ${mapIndex}${ordinalSuffix(
              mapIndex
            )} map of Week ${w.week} from ${formatTimeMs(previous.timeMs)} to ${formatTimeMs(currentTimeMs)}.`,
          };

          const added = appendChangelogItem(changelog, item);
          if (added) {
            dlog("changelog +", item.text);
          }

          setWrStateEntry(wrState, w.week, mapUid, {
            holder: currentHolder,
            holderAccountId: current.accountId,
            timeMs: currentTimeMs,
          });

          await sleep(SLEEP_MS);
          continue;
        }

        if (timeImproved && holderChanged) {
          const item = {
            type: "overtake",
            ts: isoNow(),
            week: Number(w.week),
            mapIndex,
            mapUid,
            oldHolder: previousHolderName,
            newHolder: currentHolder,
            oldHolderAccountId: previousHolderId,
            newHolderAccountId: current.accountId || null,
            oldTimeMs: previous.timeMs,
            newTimeMs: currentTimeMs,
            deltaMs: previous.timeMs - currentTimeMs,
            text: `${currentHolder} has overtaken ${previousHolderName} for the world record on the ${mapIndex}${ordinalSuffix(
              mapIndex
            )} map of Week ${w.week} with a time of ${formatTimeMs(currentTimeMs)}.`,
          };

          const added = appendChangelogItem(changelog, item);
          if (added) {
            dlog("changelog +", item.text);
          }

          setWrStateEntry(wrState, w.week, mapUid, {
            holder: currentHolder,
            holderAccountId: current.accountId,
            timeMs: currentTimeMs,
          });
        }

        await sleep(SLEEP_MS);
      }
    }
  }

  refreshChangelogNames(changelog, nameCacheObj);

  writeJson(WEEKS_INDEX_PATH, weeksIndex);
  writeJson(AGG_PATH, buildAggregate(allWeekJson, nameCacheObj, postweekMapState));
  writeJson(NAME_CACHE_PATH, nameCacheObj);

  changelog.generatedAt = isoNow();
  writeJson(CHANGELOG_PATH, changelog);

  wrState.generatedAt = isoNow();
  writeJson(WR_STATE_PATH, wrState);

  postweekMapState.generatedAt = isoNow();
  writeJson(POSTWEEK_MAP_STATE_PATH, postweekMapState);

  writeJson(GOAT_WEEKS_INDEX_PATH, buildGoatWeeksIndex(goatWeeks));
  writeJson(GOAT_AGG_PATH, buildGoatAggregate(goatWeeks, nameCacheObj));

  console.log("[DONE] Weekly Shorts updated.");
  console.log("Weeks:", allWeekJson.length);
  console.log("Frozen GOAT weeks:", goatWeeks.length);
  console.log("Changelog items:", (changelog.items || []).length);
}

function ordinalSuffix(n) {
  const v = n % 100;
  if (v >= 11 && v <= 13) return "th";
  switch (n % 10) {
    case 1:
      return "st";
    case 2:
      return "nd";
    case 3:
      return "rd";
    default:
      return "th";
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
