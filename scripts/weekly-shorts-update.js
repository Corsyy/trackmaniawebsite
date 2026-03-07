import fs from "node:fs";
import path from "node:path";

const PUBLIC_DIR = process.env.PUBLIC_DIR || ".";
const BASE_DIR = path.join(process.cwd(), PUBLIC_DIR, "data", "weekly-shorts");
const WEEKS_DIR = path.join(BASE_DIR, "weeks");

const WEEKS_INDEX_PATH = path.join(BASE_DIR, "weeks.json");
const AGG_PATH = path.join(BASE_DIR, "aggregate.json");
const CHANGELOG_PATH = path.join(BASE_DIR, "changelog.json");
const NAME_CACHE_PATH = path.join(BASE_DIR, "name-cache.json");

const DEBUG = String(process.env.DEBUG || "0") === "1";
const dlog = (...a) => DEBUG && console.log("[WS]", ...a);

const LIVE_BASE = "https://live-services.trackmania.nadeo.live";

const OAUTH_CLIENT_ID = process.env.CLIENT_ID;
const OAUTH_CLIENT_SECRET = process.env.CLIENT_SECRET;

// Ubisoft credentials (GitHub Secrets)
const UBI_EMAIL = String(process.env.UBI_EMAIL || "").trim();
const UBI_PASSWORD = String(process.env.UBI_PASSWORD || "").trim();

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

// If true, we will refuse to count WR when the map leaderboard looks broken.
const STRICT_TRUST_CHECKS = true;

// Heuristic: if rank1 is *absurdly* faster than rank2, treat it as bugged.
// (Won’t trigger for normal close times like 11480 vs 11869.)
const BUGGED_RATIO_THRESHOLD = 0.5; // rank1 < rank2 * 0.5
const BUGGED_ABSOLUTE_FLOOR_MS = 2500; // below this is almost certainly impossible in WS context

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
    const keys = ["score", "points", "value", "val", "total", "result"];
    for (const k of keys) {
      if (k in v) {
        const n = extractNumber(v[k]);
        if (Number.isFinite(n)) return n;
      }
    }
  }
  return NaN;
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

// ---------- LIVE SERVICES AUTH (Ubisoft login each run) ----------

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

async function resolveDisplayNames(nameCacheObj, ids) {
  const all = Array.from(new Set((ids || []).filter(Boolean)));
  const need = all.filter((id) => !nameCacheObj[id]);
  if (!need.length) return nameCacheObj;

  const token = await getOAuthToken();
  const CHUNK = 50;

  for (let i = 0; i < need.length; i += CHUNK) {
    const batch = need.slice(i, i + CHUNK);
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
        for (const id of batch) if (!nameCacheObj[id]) nameCacheObj[id] = id;
      } else {
        const j = await r.json();
        for (const id of batch) {
          const dn = j?.[id];
          nameCacheObj[id] = typeof dn === "string" && dn ? dn : id;
        }
      }
    } catch {
      for (const id of batch) if (!nameCacheObj[id]) nameCacheObj[id] = id;
    }

    await sleep(40);
  }

  return nameCacheObj;
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
        w?.leaderboard?.group?.uid ||
        w?.uid ||
        w?.id ||
        w?.campaignUid ||
        w?.campaignId ||
        w?.seasonId ||
        null;

      if (DEBUG && !leaderboardGroupUid) {
        console.log("[WS] missing leaderboardGroupUid for feed item", {
          year: w?.year,
          week: w?.week,
          keys: Object.keys(w || {}),
        });
      }

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

      const extracted = extractNumber(x?.score);
      const timeMs = isValidTimeMs(extracted) ? extracted : null;

      if (!Number.isFinite(rank) || rank <= 0) return null;
      return { rank, accountId, timeMs };
    })
    .filter(Boolean)
    .sort((a, b) => a.rank - b.rank);
}

async function fetchCurrentWR(access, mapUid) {
  const rows = await fetchWsTop(access, mapUid, 1);
  return rows[0] || null;
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

  // 1) Known overrides
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

  // 2) Heuristic: if the best visible time is absurdly low vs #2, drop it
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

  // 3) Trust check: leaderboard should include ranks 1 and 2 (unless "secret" rows)
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

function buildAggregate(allWeekJson, nameCacheObj = {}) {
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
      const { entriesClean, trusted } = cleanMapEntries(mapUid, m.entries || []);
      const best = entriesClean[0] || null;

      if (trusted && best?.accountId) {
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

      if (trusted) {
        for (let i = 0; i < Math.min(5, entriesClean.length); i++) {
          const e = entriesClean[i];
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

// ---------- CHANGELOG (post-week WR improvements) ----------

function loadChangelog() {
  const existing = readJson(CHANGELOG_PATH, { generatedAt: isoNow(), items: [] });
  if (!existing || typeof existing !== "object") return { generatedAt: isoNow(), items: [] };
  if (!Array.isArray(existing.items)) existing.items = [];
  return existing;
}

function changelogKey(item) {
  return `${item.week}|${item.mapUid}|${item.newTimeMs}|${item.newHolder}`;
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

  // baseline WR = best valid from snapshot after cleaning (trusted only)
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

async function main() {
  ensureDir(WEEKS_DIR);

  const access = await getLiveAccessToken();
  const weeksRaw = await fetchWeeklyShortsCampaignWeeks(access);
  const weeksIndex = buildWeeksIndexFromWeeklyShortsFeed(weeksRaw);

  const nameCacheObj = readJson(NAME_CACHE_PATH, {});
  const changelog = loadChangelog();
  const allWeekJson = [];

  const nowMs = Date.now();

  for (const w of weeksIndex.weeks || []) {
    const weekPath = path.join(WEEKS_DIR, `${w.week}.json`);
    const endedMs = Date.parse(w.endedAt);
    const isEnded = Number.isFinite(endedMs) && nowMs > endedMs;

    let weekJson = null;

    // Freeze ended weeks: if week file already exists and week ended, DO NOT overwrite.
    if (isEnded && fs.existsSync(weekPath)) {
      weekJson = readJson(weekPath, null);
    }

    if (!weekJson) {
      const maps = [];

      for (const mapUid of w.mapUids || []) {
        const rows = await fetchWsTop(access, mapUid, MAP_TOP_LENGTH);
        await resolveDisplayNames(nameCacheObj, rows.map((r) => r.accountId));

        // Raw entries
        let entries = rows.map((r) => ({
          rank: r.rank,
          accountId: r.accountId,
          player: nameCacheObj[r.accountId] || r.accountId,
          timeMs: r.timeMs,
        }));

        const cleaned = cleanMapEntries(mapUid, entries);

        // Re-rank after cleaning so "best valid" becomes rank 1,
        // but preserve original leaderboard rank in rawRank.
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
      await resolveDisplayNames(nameCacheObj, pointsRows.map((r) => r.accountId));

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

    // --------- Post-week WR changelog (ended weeks only) ----------
    if (isEnded) {
      for (let i = 0; i < (w.mapUids || []).length; i++) {
        const mapUid = w.mapUids[i];
        const mapIndex = i + 1;

        const baseline = getBaselineWRFromWeekFile(weekJson, mapUid);
        if (!baseline || !isValidTimeMs(baseline.timeMs) || !baseline.holder) continue;

        const current = await fetchCurrentWR(access, mapUid);
        if (!current) continue;

        await resolveDisplayNames(nameCacheObj, [current.accountId]);
        const currentHolder = nameCacheObj[current.accountId] || current.accountId;
        const currentTimeMs = current.timeMs;

        if (isValidTimeMs(currentTimeMs) && currentTimeMs < baseline.timeMs) {
          const item = {
            ts: isoNow(),
            week: Number(w.week),
            mapIndex,
            mapUid,
            newHolder: currentHolder,
            oldHolder: baseline.holder,
            newHolderAccountId: current.accountId || null,
            oldHolderAccountId: baseline.holderAccountId || null,
            newTimeMs: currentTimeMs,
            oldTimeMs: baseline.timeMs,
            deltaMs: baseline.timeMs - currentTimeMs,
            text: `${currentHolder} has overtaken the world record for the ${mapIndex}${ordinalSuffix(
              mapIndex
            )} map of Week ${w.week}, previously held by ${baseline.holder}.`,
          };

          const added = appendChangelogItem(changelog, item);
          if (added) dlog("changelog +", item.text);
        }

        await sleep(SLEEP_MS);
      }
    }
  }

  writeJson(WEEKS_INDEX_PATH, weeksIndex);
  writeJson(AGG_PATH, buildAggregate(allWeekJson, nameCacheObj));
  writeJson(NAME_CACHE_PATH, nameCacheObj);

  changelog.generatedAt = isoNow();
  writeJson(CHANGELOG_PATH, changelog);

  console.log("[DONE] Weekly Shorts updated.");
  console.log("Weeks:", allWeekJson.length);
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
