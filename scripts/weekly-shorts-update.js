
import { mkdir, writeFile, readFile, access, readdir } from "node:fs/promises";
import { constants as FS } from "node:fs";
import path from "node:path";

/* ----------------------------- config/constants ---------------------------- */
const PUBLIC_DIR = process.env.PUBLIC_DIR || ".";
const OUT_DIR = `${PUBLIC_DIR.replace(/\/+$/, "")}/data/weekly-shorts`;
const WEEKS_INDEX_PATH = `${OUT_DIR}/weeks.json`;
const WEEKS_DIR = `${OUT_DIR}/weeks`;
const AGG_PATH = `${OUT_DIR}/aggregate.json`;
const CHANGELOG_PATH = `${OUT_DIR}/changelog.json`;

const LIVE_BASE = "https://live-services.trackmania.nadeo.live";
const CORE_REFRESH_URL =
  "https://prod.trackmania.core.nadeo.online/v2/authentication/token/refresh";

const WS_MATCH = (process.env.WS_MATCH || "weekly shorts").toLowerCase();

const DEBUG = process.env.DEBUG === "1";
const dlog = (...a) => {
  if (DEBUG) console.log("[WS]", ...a);
};

/* -------------------------------- fs helpers ------------------------------- */
const ensureDir = async (p) => mkdir(p, { recursive: true });
const exists = async (p) => {
  try {
    await access(p, FS.F_OK);
    return true;
  } catch {
    return false;
  }
};
const loadJson = async (p, fallback) => {
  if (!(await exists(p))) return fallback;
  try {
    return JSON.parse(await readFile(p, "utf8"));
  } catch {
    return fallback;
  }
};
const writeJson = async (p, obj) =>
  writeFile(p, JSON.stringify(obj, null, 2), "utf8");

/* --------------------------------- utils ----------------------------------- */
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const nowIso = () => new Date().toISOString();

function cleanToken(s) {
  if (!s) return "";
  let t = String(s).trim();
  if (t.toLowerCase().startsWith("nadeo_v1 t=")) t = t.slice("nadeo_v1 t=".length).trim();
  if ((t.startsWith('"') && t.endsWith('"')) || (t.startsWith("'") && t.endsWith("'")))
    t = t.slice(1, -1);
  return t;
}

function fmtTime(ms) {
  const n = Number(ms);
  if (!Number.isFinite(n) || n <= 0) return "-";
  const total = Math.floor(n / 1000);
  const milli = n % 1000;
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${m}:${String(s).padStart(2, "0")}.${String(milli).padStart(3, "0")}`;
}

function safeLower(s) {
  return (s ?? "").toString().toLowerCase();
}

function pickCampaignName(it) {
  // club campaign list responses vary; try multiple fields
  return (
    it?.campaign?.name ||
    it?.campaignName ||
    it?.name ||
    it?.campaign?.displayName ||
    it?.displayName ||
    ""
  );
}

function pickCampaignId(it) {
  return it?.id ?? it?.campaignId ?? it?.campaign?.id ?? null;
}
function pickClubId(it) {
  return it?.clubId ?? it?.campaign?.clubId ?? it?.club?.id ?? null;
}

/* -------------------------- fetch + retry helpers -------------------------- */
const USER_AGENT = process.env.USER_AGENT || "trackmaniaevents.com weekly-shorts/1.0";

async function fetchRetry(url, opts = {}, retries = 5, baseDelay = 600) {
  let lastErr;
  for (let i = 0; i <= retries; i++) {
    try {
      const r = await fetch(url, {
        ...opts,
        headers: {
          "User-Agent": USER_AGENT,
          ...(opts.headers || {}),
        },
      });

      if (r.status === 429 || (r.status >= 500 && r.status <= 599)) {
        const wait = Math.min(baseDelay * 2 ** i, 8000);
        dlog("retry", i, r.status, url, `wait=${wait}ms`);
        await sleep(wait);
        continue;
      }
      return r;
    } catch (e) {
      lastErr = e;
      const wait = Math.min(baseDelay * 2 ** i, 8000);
      dlog("retry", i, "err", e?.message || e, url, `wait=${wait}ms`);
      await sleep(wait);
    }
  }
  throw lastErr || new Error(`fetch failed: ${url}`);
}

async function jget(url, headers = {}) {
  const r = await fetchRetry(url, { headers: { Accept: "application/json", ...headers } });
  if (!r.ok) throw new Error(`${url} -> ${r.status}`);
  return r.json();
}

/* ------------------------------- auth tokens ------------------------------- */
let cachedAccess = { token: null, expAt: 0 };
async function getLiveAccessToken() {
  const now = Date.now();
  if (cachedAccess.token && now < cachedAccess.expAt - 30_000) return cachedAccess.token;

  const refresh = cleanToken(process.env.REFRESH_TOKEN || "");
  if (!refresh) throw new Error("Missing REFRESH_TOKEN");

  const r = await fetchRetry(CORE_REFRESH_URL, {
    method: "POST",
    headers: {
      Authorization: `nadeo_v1 t=${refresh}`,
      "Content-Type": "application/json",
      Accept: "application/json",
      "User-Agent": USER_AGENT,
    },
    body: "{}",
  });

  if (!r.ok) {
    const body = await r.text().catch(() => "");
    throw new Error(`refresh failed ${r.status} ${body || "(no body)"} [len=${refresh.length}]`);
  }

  const j = await r.json();
  const accessToken = j.accessToken || j.access_token;
  const expiresIn = j.expiresIn || j.expires_in || 3600;
  if (!accessToken) throw new Error("no accessToken in refresh response");

  cachedAccess = { token: accessToken, expAt: Date.now() + expiresIn * 1000 };
  return cachedAccess.token;
}

let cachedOAuth = { token: null, expAt: 0 };
async function getOAuthToken() {
  const now = Date.now();
  if (cachedOAuth.token && now < cachedOAuth.expAt - 30_000) return cachedOAuth.token;

  const CLIENT_ID = process.env.CLIENT_ID;
  const CLIENT_SECRET = process.env.CLIENT_SECRET;
  if (!CLIENT_ID || !CLIENT_SECRET) throw new Error("Missing CLIENT_ID / CLIENT_SECRET");

  const r = await fetchRetry("https://api.trackmania.com/api/access_token", {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Accept: "application/json",
      "User-Agent": USER_AGENT,
    },
    body: new URLSearchParams({
      grant_type: "client_credentials",
      client_id: CLIENT_ID,
      client_secret: CLIENT_SECRET,
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

/* ------------------------ display name resolution -------------------------- */
const nameCache = new Map(); // accountId -> displayName

async function resolveDisplayNames(ids) {
  const all = Array.from(new Set((ids || []).filter(Boolean)));
  const need = all.filter((id) => !nameCache.has(id));
  if (!need.length) return;

  const token = await getOAuthToken();
  const CHUNK = 50;

  for (let i = 0; i < need.length; i += CHUNK) {
    const batch = need.slice(i, i + CHUNK);
    const params = new URLSearchParams();
    for (const id of batch) params.append("accountId[]", id);

    try {
      const r = await fetchRetry(
        `https://api.trackmania.com/api/display-names?${params.toString()}`,
        {
          headers: {
            Authorization: `Bearer ${token}`,
            Accept: "application/json",
            "User-Agent": USER_AGENT,
          },
        }
      );
      if (!r.ok) {
        for (const id of batch) if (!nameCache.has(id)) nameCache.set(id, id);
        continue;
      }
      const j = await r.json(); // { "<accountId>": "DisplayName" }
      for (const id of batch) {
        const dn = j?.[id];
        nameCache.set(id, (typeof dn === "string" && dn) || id);
      }
    } catch {
      for (const id of batch) if (!nameCache.has(id)) nameCache.set(id, id);
    }

    await sleep(40);
  }
}

/* ---------------------- weekly shorts auto-discovery ----------------------- */
async function listAllClubCampaignRefs(accessToken, max = 400) {
  const out = [];
  const BATCH = 100;

  for (let offset = 0; offset < max; offset += BATCH) {
    const url = `${LIVE_BASE}/api/token/club/campaign?length=${BATCH}&offset=${offset}`;
    let j;
    try {
      j = await jget(url, { Authorization: `nadeo_v1 t=${accessToken}` });
    } catch (e) {
      // if paging fails later, break
      dlog("club list failed", offset, e?.message || e);
      break;
    }

    const list = j?.clubCampaignList || j?.campaignList || [];
    if (!Array.isArray(list) || !list.length) break;

    for (const it of list) {
      const clubId = pickClubId(it);
      const campaignId = pickCampaignId(it);
      const name = pickCampaignName(it);
      const updatedAt =
        new Date(it?.updated || it?.updatedAt || it?.campaign?.updated || 0).getTime() || 0;

      if (clubId && campaignId) out.push({ clubId, campaignId, name, updatedAt });
    }

    if (list.length < BATCH) break;
    await sleep(60);
  }

  out.sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
  return out;
}

async function fetchClubCampaignDetail(accessToken, clubId, campaignId) {
  const url = `${LIVE_BASE}/api/token/club/${encodeURIComponent(clubId)}/campaign/${encodeURIComponent(
    campaignId
  )}`;
  const j = await jget(url, { Authorization: `nadeo_v1 t=${accessToken}` });

  const name = j?.campaign?.name || j?.name || "";
  const playlist = (j?.campaign?.playlist || j?.playlist || []).map((p) => ({
    mapUid: p?.mapUid,
    mapName: p?.mapName || p?.name || null,
  }));

  return { name, playlist };
}

async function discoverWeeklyShortsWeeks(prevWeeksIndex) {
  const access = await getLiveAccessToken();

  // If user pins exact ids, use them
  const pinnedClubId = process.env.WS_CLUB_ID;
  const pinnedCampaignId = process.env.WS_CAMPAIGN_ID;

  let chosen = null;

  if (pinnedClubId && pinnedCampaignId) {
    chosen = {
      clubId: pinnedClubId,
      campaignId: pinnedCampaignId,
      name: "Weekly Shorts (pinned)",
      updatedAt: Date.now(),
    };
  } else {
    const refs = await listAllClubCampaignRefs(access, 500);
    const matches = refs.filter((r) => safeLower(r.name).includes(WS_MATCH));
    if (!matches.length) {
      // fallback: try looser match
      const loose = refs.filter((r) => safeLower(r.name).includes("short"));
      const top = loose[0] || refs[0];
      throw new Error(
        `Could not find a club campaign matching "${WS_MATCH}". Top candidate was "${top?.name || "(none)"}". ` +
          `Set WS_CLUB_ID + WS_CAMPAIGN_ID to pin it.`
      );
    }
    chosen = matches[0]; // most recently updated due to sort
  }

  const detail = await fetchClubCampaignDetail(access, chosen.clubId, chosen.campaignId);
  const playlist = (detail.playlist || []).filter((p) => p?.mapUid);

  if (!playlist.length) {
    throw new Error(
      `Weekly Shorts campaign playlist empty. clubId=${chosen.clubId} campaignId=${chosen.campaignId}`
    );
  }

  // Build weeks array from playlist order
  const discoveredAt = nowIso();
  const prevWeeks = Array.isArray(prevWeeksIndex?.weeks) ? prevWeeksIndex.weeks : [];
  const prevCount = prevWeeks.length;
  const newCount = playlist.length;

  // Map previous endedAt + names by mapUid/week
  const prevEndedAtByWeek = new Map(prevWeeks.map((w) => [Number(w.week), w.endedAt || null]));
  const prevMapNameByUid = new Map(prevWeeks.map((w) => [w.mapUid, w.mapName || null]));

  // If campaign grew (new week added), auto-close the previous last week
  if (prevCount > 0 && newCount > prevCount) {
    const prevLastWeekNum = prevCount;
    const alreadyEnded = prevEndedAtByWeek.get(prevLastWeekNum);
    if (!alreadyEnded) {
      dlog(`Detected new week (${prevCount} -> ${newCount}). Auto-setting endedAt for week ${prevLastWeekNum}.`);
      prevEndedAtByWeek.set(prevLastWeekNum, discoveredAt);
    }
  }

  const weeks = playlist.map((p, i) => {
    const weekNum = i + 1;
    const mapUid = p.mapUid;
    const mapName = p.mapName || prevMapNameByUid.get(mapUid) || null;

    // endedAt: keep previous value if present; otherwise:
    // - if not last week and we have a previous value (or auto-set), use it
    // - if last week, keep null (still ongoing)
    const prevEnded = prevEndedAtByWeek.get(weekNum) || null;
    const endedAt = weekNum === playlist.length ? null : prevEnded; // only non-last weeks can have endedAt

    return { week: weekNum, mapUid, mapName, endedAt };
  });

  const weeksIndex = {
    campaign: detail.name || "Weekly Shorts",
    game: "Trackmania 2020",
    clubId: chosen.clubId,
    campaignId: chosen.campaignId,
    match: WS_MATCH,
    discoveredAt,
    weeks,
  };

  return weeksIndex;
}

/* ----------------------- leaderboard fetch + build ------------------------- */
async function fetchMapTop(accessToken, mapUid, length = 10) {
  const groupUid = "Personal_Best";
  const url = `${LIVE_BASE}/api/token/leaderboard/group/${groupUid}/map/${encodeURIComponent(
    mapUid
  )}/top?onlyWorld=true&length=${length}`;

  const j = await jget(url, { Authorization: `nadeo_v1 t=${accessToken}` });
  const top = j?.tops?.[0]?.top || [];

  // Each entry has accountId, score(ms), timestamp
  return top
    .map((x, idx) => ({
      rank: idx + 1,
      accountId: x?.accountId || null,
      timeMs: Number(x?.score),
      timestamp: x?.timestamp ? Number(x.timestamp) : null,
    }))
    .filter((e) => e.accountId && Number.isFinite(e.timeMs) && e.timeMs > 0);
}

async function buildWeekFile(weekRec, accessToken, prevWeekFile) {
  const { week, mapUid } = weekRec;

  const top = await fetchMapTop(accessToken, mapUid, 10);
  const ids = top.map((t) => t.accountId).filter(Boolean);
  await resolveDisplayNames(ids);

  const entries = top.map((t) => ({
    rank: t.rank,
    accountId: t.accountId,
    player: nameCache.get(t.accountId) || t.accountId,
    timeMs: t.timeMs,
    timestamp: t.timestamp || null,
    isWr: t.rank === 1,
    isWinner: t.rank === 1,
  }));

  const mapName =
    weekRec.mapName ||
    prevWeekFile?.mapName ||
    null;

  const out = {
    week,
    mapUid,
    mapName,
    endedAt: weekRec.endedAt || null,
    entries,
    generatedAt: nowIso(),
  };

  return out;
}

/* --------------------------- aggregate + changelog ------------------------- */
function buildAggregate(weeksIndex, weekFiles) {
  const players = new Map(); // name -> stats

  for (const wf of weekFiles) {
    const weekNum = wf.week;
    const mapUid = wf.mapUid;

    const top5 = (wf.entries || []).slice(0, 5);

    for (const e of top5) {
      const key = e.player || e.accountId;
      if (!key) continue;

      const rec =
        players.get(key) || {
          player: key,
          wins: 0,
          wrs: 0,
          top5: 0,
          weeksWon: [],
          wrWeeks: [],
          top5Weeks: [],
        };

      rec.top5 += 1;
      rec.top5Weeks.push({
        week: weekNum,
        rank: e.rank,
        mapUid,
        timeMs: e.timeMs,
      });

      if (e.rank === 1) {
        rec.wins += 1;
        rec.wrs += 1;
        rec.weeksWon.push(weekNum);
        rec.wrWeeks.push({
          week: weekNum,
          mapUid,
          timeMs: e.timeMs,
        });
      }

      players.set(key, rec);
    }
  }

  const list = Array.from(players.values()).sort(
    (a, b) =>
      b.wins - a.wins ||
      b.wrs - a.wrs ||
      b.top5 - a.top5 ||
      a.player.localeCompare(b.player)
  );

  return {
    generatedAt: nowIso(),
    players: list,
    totalPlayers: list.length,
    weeksCount: Array.isArray(weeksIndex?.weeks) ? weeksIndex.weeks.length : 0,
  };
}

function buildChangelogItem({ week, mapUid, newW, oldW, endedAt }) {
  const newName = newW?.player || newW?.accountId || "(unknown)";
  const oldName = oldW?.player || oldW?.accountId || "(unknown)";
  const newTime = fmtTime(newW?.timeMs);
  const oldTime = fmtTime(oldW?.timeMs);

  // Message format like you requested
  const msg =
    `${newName} improved Week ${week} WR ` +
    `(previously held by ${oldName}) ` +
    `with a time of ${newTime} (previous ${oldTime}).`;

  return {
    ts: nowIso(),
    week,
    mapUid,
    endedAt: endedAt || null,
    newHolder: newName,
    oldHolder: oldName,
    newTimeMs: newW?.timeMs ?? null,
    oldTimeMs: oldW?.timeMs ?? null,
    message: msg,
  };
}

function keyForItem(it) {
  return `${it.week}|${it.mapUid}|${it.newHolder}|${it.newTimeMs}|${it.oldHolder}|${it.oldTimeMs}`;
}

function mergeChangelog(prev, nextItems, limit = 200) {
  const prevItems = Array.isArray(prev?.items) ? prev.items : [];
  const seen = new Set(prevItems.map(keyForItem));
  const merged = [...prevItems];

  for (const it of nextItems) {
    const k = keyForItem(it);
    if (seen.has(k)) continue;
    seen.add(k);
    merged.unshift(it); // newest first
  }

  return {
    generatedAt: nowIso(),
    items: merged.slice(0, limit),
  };
}

/* ----------------------------------- main ---------------------------------- */
async function main() {
  await ensureDir(OUT_DIR);
  await ensureDir(WEEKS_DIR);

  // Load previous weeks index (if any)
  const prevWeeksIndex = await loadJson(WEEKS_INDEX_PATH, null);

  // Auto-discover weekly shorts weeks (campaign playlist)
  const weeksIndex = await discoverWeeklyShortsWeeks(prevWeeksIndex);
  await writeJson(WEEKS_INDEX_PATH, weeksIndex);
  dlog("weeks discovered:", weeksIndex.weeks.length, "clubId=", weeksIndex.clubId, "campaignId=", weeksIndex.campaignId);

  // Build all weeks
  const access = await getLiveAccessToken();

  const weekFiles = [];
  const changelogCandidates = [];

  for (const w of weeksIndex.weeks) {
    const weekNum = Number(w.week);
    const weekPath = path.join(WEEKS_DIR, `${weekNum}.json`);
    const prevWeekFile = await loadJson(weekPath, null);

    // Build new week file
    const wf = await buildWeekFile(w, access, prevWeekFile);
    await writeJson(weekPath, wf);
    weekFiles.push(wf);

    // Changelog rule:
    // If week has endedAt, and endedAt < now, and WR changed/improved since last file -> log it.
    const endedAt = wf.endedAt ? Date.parse(wf.endedAt) : 0;
    const ended = endedAt && Date.now() > endedAt;

    if (ended && prevWeekFile?.entries?.length && wf.entries?.length) {
      const oldWr = prevWeekFile.entries.find((e) => e.rank === 1) || prevWeekFile.entries[0];
      const newWr = wf.entries.find((e) => e.rank === 1) || wf.entries[0];

      if (oldWr && newWr) {
        const changedHolder = (oldWr.accountId || oldWr.player) !== (newWr.accountId || newWr.player);
        const improvedTime =
          Number.isFinite(Number(oldWr.timeMs)) &&
          Number.isFinite(Number(newWr.timeMs)) &&
          Number(newWr.timeMs) < Number(oldWr.timeMs);

        if (changedHolder || improvedTime) {
          changelogCandidates.push(
            buildChangelogItem({
              week: weekNum,
              mapUid: wf.mapUid,
              newW: newWr,
              oldW: oldWr,
              endedAt: wf.endedAt,
            })
          );
        }
      }
    }

    // be nice to APIs
    await sleep(120);
  }

  // Aggregate
  const agg = buildAggregate(weeksIndex, weekFiles);
  await writeJson(AGG_PATH, agg);

  // Changelog merge
  const prevChangelog = await loadJson(CHANGELOG_PATH, null);
  const merged = mergeChangelog(prevChangelog, changelogCandidates, 200);
  await writeJson(CHANGELOG_PATH, merged);

  console.log("[DONE] Weekly Shorts updated.");
  console.log(`- weeks: ${weeksIndex.weeks.length}`);
  console.log(`- aggregate players: ${agg.totalPlayers}`);
  console.log(`- changelog items: ${merged.items.length}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
