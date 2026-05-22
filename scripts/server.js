import express from "express";
import fetch from "node-fetch";
import fs from "fs";
import path from "path";
import compression from "compression";
import http from "http";
import https from "https";
import crypto from "crypto";

const app = express();

app.use(compression({ level: 6 }));
app.use(express.json({ limit: "1mb" }));

const keepAliveHttpAgent = new http.Agent({ keepAlive: true, maxSockets: 50 });
const keepAliveHttpsAgent = new https.Agent({ keepAlive: true, maxSockets: 50 });

const baseFetch = (url, opts = {}) =>
    fetch(url, {
        agent: String(url).startsWith("https:") ? keepAliveHttpsAgent : keepAliveHttpAgent,
        ...opts,
    });

const DEFAULT_ORIGINS = new Set([
    "https://trackmaniaevents.com",
    "https://www.trackmaniaevents.com",
    "http://localhost:5500",
    "http://127.0.0.1:5500",
]);

const EXTRA_ORIGINS = (process.env.CORS_ORIGINS || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);

const ALLOW_ORIGINS = new Set([...DEFAULT_ORIGINS, ...EXTRA_ORIGINS]);

app.use((req, res, next) => {
    const origin = req.headers.origin;
    if (origin && ALLOW_ORIGINS.has(origin)) {
        res.setHeader("Access-Control-Allow-Origin", origin);
    }

    res.setHeader("Vary", "Origin");
    res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS, POST");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization, X-Admin-Secret");

    if (req.method === "OPTIONS") return res.sendStatus(200);
    next();
});

const PUBLIC_DIR = process.env.PUBLIC_DIR || path.join(process.cwd(), "public");
const DATA_ROOT = process.env.DATA_ROOT || path.join(PUBLIC_DIR, "data");

const MAPS_DIR = path.join(DATA_ROOT, "maps");
const PLAYERS_DIR = path.join(DATA_ROOT, "players");
const WR_EVENTS_DIR = path.join(DATA_ROOT, "wr-events");
const FEEDS_DIR = path.join(DATA_ROOT, "feeds");
const LEADERBOARDS_DIR = path.join(DATA_ROOT, "leaderboards");
const METADATA_DIR = path.join(DATA_ROOT, "metadata");
const RECENT_WRS_DIR = path.join(DATA_ROOT, "recent-wrs");
const WR_LEADERBOARD_DIR = path.join(DATA_ROOT, "wr-leaderboard");

[
    PUBLIC_DIR,
    DATA_ROOT,
    MAPS_DIR,
    PLAYERS_DIR,
    WR_EVENTS_DIR,
    FEEDS_DIR,
    LEADERBOARDS_DIR,
    METADATA_DIR,
    RECENT_WRS_DIR,
    WR_LEADERBOARD_DIR,
].forEach((dir) => fs.mkdirSync(dir, { recursive: true }));

const LIVE_BASE = "https://live-services.trackmania.nadeo.live";
const CORE_REFRESH_URL = "https://prod.trackmania.core.nadeo.online/v2/authentication/token/refresh";

const REFRESH_TOKEN_FILE = process.env.REFRESH_TOKEN_FILE || "/data/nadeo_refresh_token.txt";
const OAUTH_CLIENT_ID = process.env.CLIENT_ID;
const OAUTH_CLIENT_SECRET = process.env.CLIENT_SECRET;
const ADMIN_SECRET = process.env.ADMIN_SECRET;

const WR_CONCURRENCY = Math.max(1, Number(process.env.WR_CONCURRENCY || 8));
const CLUB_LIST_BATCH = Math.max(1, Number(process.env.CLUB_LIST_BATCH || 100));
const CLUB_DETAIL_CONC = Math.max(1, Number(process.env.CLUB_DETAIL_CONC || 4));
const CLUB_MAX_CAMPAIGNS = Math.max(1, Number(process.env.CLUB_MAX_CAMPAIGNS || 500));
const CLUB_UID_TTL = Math.max(1, Number(process.env.CLUB_UID_TTL_HOURS || 24)) * 3600 * 1000;
const QUICK_REFRESH_COUNT = Math.max(1, Number(process.env.QUICK_REFRESH_COUNT || 200));
const RESPONSE_TTL_SECONDS = Math.max(0, Number(process.env.RESPONSE_TTL_SECONDS || 3));
const MAX_WR_MS = Math.max(1, Number(process.env.MAX_WR_MS || 24 * 3600 * 1000));
const AUTO_UID_REFRESH = (process.env.AUTO_UID_REFRESH ?? "true").toLowerCase() === "true";
const AUTO_STATIC_WRITE = (process.env.AUTO_STATIC_WRITE ?? "true").toLowerCase() === "true";
const INCLUDE_CLUB_BY_DEFAULT = (process.env.INCLUDE_CLUB_BY_DEFAULT ?? "true").toLowerCase() === "true";

const DISK_WR = process.env.CACHE_PATH_WR || "/tmp/wr_cache.json";
const DISK_CLUB = process.env.CACHE_PATH_CLUB || "/tmp/club_uids.json";
const DISK_MAP_INDEX = process.env.CACHE_PATH_MAP_INDEX || path.join(METADATA_DIR, "map-index.json");
const MANUAL_MAPS_FILE = process.env.MANUAL_MAPS_FILE || path.join(METADATA_DIR, "manual-maps.json");

let runtimeRefreshToken = cleanToken(process.env.REFRESH_TOKEN || "");
let cachedAccess = { token: null, expAt: 0 };
let cachedOAuth = { token: null, expAt: 0 };
let wrCache = { ts: 0, rows: [] };
let metaCache = {
    allMapUids: [],
    officialSet: new Set(),
    totdSet: new Set(),
    clubSet: new Set(),
    manualSet: new Set(),
    mapMeta: new Map(),
};

const nameCache = new Map();
const respCache = new Map();
let building = false;

function cleanToken(value) {
    if (!value) return "";
    let token = String(value).trim();
    if (token.toLowerCase().startsWith("nadeo_v1 t=")) token = token.slice("nadeo_v1 t=".length).trim();
    if ((token.startsWith('"') && token.endsWith('"')) || (token.startsWith("'") && token.endsWith("'"))) {
        token = token.slice(1, -1);
    }
    return token;
}

function readJson(filePath, fallback = null) {
    try {
        if (!fs.existsSync(filePath)) return fallback;
        return JSON.parse(fs.readFileSync(filePath, "utf8"));
    } catch {
        return fallback;
    }
}

function writeJson(filePath, payload, pretty = true) {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, JSON.stringify(payload, null, pretty ? 2 : 0));
}

function getRefreshToken() {
    try {
        if (fs.existsSync(REFRESH_TOKEN_FILE)) {
            const token = cleanToken(fs.readFileSync(REFRESH_TOKEN_FILE, "utf8"));
            if (token) return token;
        }
    } catch { }
    return runtimeRefreshToken;
}

function persistRefreshToken(refreshToken) {
    const cleaned = cleanToken(refreshToken);
    if (!cleaned) return;

    try {
        fs.mkdirSync(path.dirname(REFRESH_TOKEN_FILE), { recursive: true });
        fs.writeFileSync(REFRESH_TOKEN_FILE, cleaned, "utf8");
        runtimeRefreshToken = cleaned;
    } catch (error) {
        console.error("Failed to persist refresh token:", error?.message || error);
    }
}

function fetchWithTimeout(url, opts = {}, ms = 15000) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), ms);
    return baseFetch(url, { ...opts, signal: controller.signal }).finally(() => clearTimeout(timeout));
}

async function getLiveAccessToken() {
    const now = Date.now();
    if (cachedAccess.token && now < cachedAccess.expAt - 30_000) return cachedAccess.token;

    const refreshToken = getRefreshToken();
    if (!refreshToken) throw new Error("Missing REFRESH_TOKEN");

    const response = await fetchWithTimeout(
        CORE_REFRESH_URL,
        {
            method: "POST",
            headers: {
                Authorization: `nadeo_v1 t=${refreshToken}`,
                "Content-Type": "application/json",
                "User-Agent": "trackmaniaevents.com/1.0",
            },
            body: "{}",
        },
        15000
    );

    if (!response.ok) {
        const body = await response.text().catch(() => "");
        throw new Error(`refresh failed ${response.status} ${body || "(no body)"}`);
    }

    const json = await response.json();
    const accessToken = json.accessToken || json.access_token;
    const expiresIn = json.expiresIn || json.expires_in || 3600;
    const newRefreshToken = json.refreshToken || json.refresh_token;

    if (!accessToken) throw new Error("No access token returned from Nadeo refresh.");

    if (typeof newRefreshToken === "string" && newRefreshToken.trim()) {
        persistRefreshToken(newRefreshToken);
    }

    cachedAccess = { token: accessToken, expAt: Date.now() + expiresIn * 1000 };
    return cachedAccess.token;
}

async function getOAuthToken() {
    const now = Date.now();
    if (cachedOAuth.token && now < cachedOAuth.expAt - 30_000) return cachedOAuth.token;
    if (!OAUTH_CLIENT_ID || !OAUTH_CLIENT_SECRET) throw new Error("Missing CLIENT_ID / CLIENT_SECRET");

    const response = await fetchWithTimeout(
        "https://api.trackmania.com/api/access_token",
        {
            method: "POST",
            headers: {
                "Content-Type": "application/x-www-form-urlencoded",
                "User-Agent": "trackmaniaevents.com/1.0",
            },
            body: new URLSearchParams({
                grant_type: "client_credentials",
                client_id: OAUTH_CLIENT_ID,
                client_secret: OAUTH_CLIENT_SECRET,
            }).toString(),
        },
        15000
    );

    if (!response.ok) throw new Error(`OAuth token failed ${response.status} ${await response.text()}`);

    const json = await response.json();
    const accessToken = json.access_token || json.accessToken;
    const expiresIn = json.expires_in || 3600;

    if (!accessToken) throw new Error("No OAuth access token returned.");

    cachedOAuth = { token: accessToken, expAt: Date.now() + expiresIn * 1000 };
    return cachedOAuth.token;
}

async function jget(url, accessToken) {
    const response = await fetchWithTimeout(
        url,
        {
            headers: {
                Authorization: `nadeo_v1 t=${accessToken}`,
                "User-Agent": "trackmaniaevents.com/1.0",
                Accept: "application/json",
            },
        },
        15000
    );

    if (!response.ok) {
        const text = await response.text().catch(() => "");
        throw new Error(`${url} -> ${response.status} ${text}`);
    }

    return response.json();
}

function sendJsonETag(req, res, obj, opts = {}) {
    const { maxAge = 60, stale = 300, noStore = false } = opts;
    const body = JSON.stringify(obj);
    const etag = `"${crypto.createHash("sha1").update(body).digest("hex")}"`;

    res.setHeader("ETag", etag);
    res.setHeader(
        "Cache-Control",
        noStore ? "no-store" : `public, max-age=${Math.max(0, maxAge)}, stale-while-revalidate=${Math.max(0, stale)}`
    );

    if (req.headers["if-none-match"] === etag) return res.status(304).end();
    res.type("application/json").send(body);
}

function cacheKey(req) {
    return req.originalUrl || req.url;
}

function getCached(req) {
    const key = cacheKey(req);
    const item = respCache.get(key);
    if (!item) return null;

    if (Date.now() - item.ts > RESPONSE_TTL_SECONDS * 1000) {
        respCache.delete(key);
        return null;
    }

    return item.body;
}

function setCached(req, payload) {
    const key = cacheKey(req);
    respCache.set(key, { ts: Date.now(), body: payload });

    if (respCache.size > 200) {
        const first = respCache.keys().next().value;
        if (first) respCache.delete(first);
    }
}

function normalizeToSeconds(value) {
    if (value == null) return 0;

    const number = Number(value);
    if (Number.isFinite(number)) return number > 1e12 ? Math.round(number / 1000) : Math.round(number);

    const parsed = Date.parse(String(value));
    if (Number.isFinite(parsed)) return parsed > 1e12 ? Math.round(parsed / 1000) : Math.round(parsed);

    return 0;
}

function isValidTimeMs(ms) {
    return Number.isFinite(ms) && ms > 0 && ms < MAX_WR_MS;
}

function sanitizeRow(row) {
    if (!row || row.empty || row.error) return null;

    const timeMs = Number(row.timeMs);
    if (!isValidTimeMs(timeMs)) return null;
    if (!row.accountId || typeof row.accountId !== "string") return null;
    if (!row.mapUid || typeof row.mapUid !== "string") return null;

    return { ...row, timeMs };
}

function detroitDate(tsMs) {
    return new Intl.DateTimeFormat("en-CA", {
        timeZone: "America/Detroit",
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
    })
        .format(new Date(tsMs))
        .replaceAll("/", "-");
}

function mapSourcePriority(sourceType) {
    const order = {
        manual_event: 100,
        official_campaign: 90,
        totd: 80,
        club_campaign: 70,
        discovered: 10,
    };
    return order[sourceType] || 0;
}

function addMapMeta(map, uid, sourceType, extra = {}) {
    if (!uid) return;

    const existing = map.get(uid);
    const next = {
        mapUid: uid,
        sourceType,
        sources: Array.from(new Set([...(existing?.sources || []), sourceType])),
        firstSeenAt: existing?.firstSeenAt || Date.now(),
        updatedAt: Date.now(),
        ...existing,
        ...extra,
    };

    if (!existing || mapSourcePriority(sourceType) >= mapSourcePriority(existing.sourceType)) {
        next.sourceType = sourceType;
    }

    next.sources = Array.from(new Set([...(existing?.sources || []), sourceType, ...(extra.sources || [])]));
    map.set(uid, next);
}

function normalizeManualMaps(raw) {
    if (!raw) return [];
    if (Array.isArray(raw)) return raw;
    if (Array.isArray(raw.maps)) return raw.maps;
    return [];
}

function loadManualMaps() {
    const manual = normalizeManualMaps(readJson(MANUAL_MAPS_FILE, []));

    return manual
        .map((item) => {
            if (typeof item === "string") return { mapUid: item, sourceType: "manual_event" };
            return {
                mapUid: item.mapUid || item.uid,
                sourceType: item.sourceType || item.category || "manual_event",
                name: item.name || item.mapName || null,
                event: item.event || item.eventName || null,
                campaign: item.campaign || null,
                tags: Array.isArray(item.tags) ? item.tags : [],
            };
        })
        .filter((item) => item.mapUid);
}

function countMonthsFrom2020July() {
    const start = new Date(Date.UTC(2020, 6, 1));
    const now = new Date();
    const end = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
    let count = 0;

    for (let d = start; d <= end; d = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1))) {
        count++;
    }

    return count;
}

async function getTotdMonthsFromLive(accessToken) {
    const total = countMonthsFrom2020July();
    const months = [];
    const batchSize = 24;

    for (let offset = total - 1; offset >= 0; offset -= batchSize) {
        const length = Math.min(batchSize, offset + 1);
        const url = `${LIVE_BASE}/api/token/campaign/month?length=${length}&offset=${offset}`;
        const json = await jget(url, accessToken);
        const list = json?.monthList || [];

        months.push(...list);
        await new Promise((resolve) => setTimeout(resolve, 60));
    }

    return months;
}

async function getOfficialCampaigns(accessToken) {
    const url = `${LIVE_BASE}/api/campaign/official?offset=0&length=200`;
    const json = await jget(url, accessToken);
    return json?.campaignList || [];
}

async function getArcadeRooms(accessToken) {
    try {
        const url = `${LIVE_BASE}/api/token/club/room?length=100&offset=0`;
        const json = await jget(url, accessToken);

        return json?.clubRoomList || json?.roomList || [];
    } catch (e) {
        console.error("Arcade room fetch failed:", e?.message || e);
        return [];
    }
}

async function getCompetitions(accessToken) {
    try {
        const url = `${LIVE_BASE}/api/token/competition?length=100&offset=0`;
        const json = await jget(url, accessToken);

        return json?.competitionList || [];
    } catch (e) {
        console.error("Competition fetch failed:", e?.message || e);
        return [];
    }
}

async function getMatchmakingMaps(accessToken) {
    try {
        const url = `${LIVE_BASE}/api/token/matchmaking/playlist`;
        const json = await jget(url, accessToken);

        return json?.mapList || json?.playlist || [];
    } catch (e) {
        console.error("Matchmaking discovery failed:", e?.message || e);
        return [];
    }
}

async function getLiveEvents(accessToken) {
    try {
        const url = `${LIVE_BASE}/api/token/live/challenge?length=100&offset=0`;
        const json = await jget(url, accessToken);

        return json?.challengeList || json?.eventList || [];
    } catch (e) {
        console.error("Live events fetch failed:", e?.message || e);
        return [];
    }
}

async function listAllClubCampaignRefsWithPlaylists(accessToken) {
    const out = [];

    for (let offset = 0; ; offset += CLUB_LIST_BATCH) {
        const url = `${LIVE_BASE}/api/token/club/campaign?length=${CLUB_LIST_BATCH}&offset=${offset}`;
        const json = await jget(url, accessToken);
        const list = json?.clubCampaignList || json?.campaignList || [];

        if (!list.length) break;

        for (const item of list) {
            const clubId = item?.clubId ?? item?.campaign?.clubId ?? item?.club?.id;
            const campaignId = item?.id ?? item?.campaignId ?? item?.campaign?.id;
            const updatedAt = new Date(item?.updated || item?.updatedAt || 0).getTime() || 0;
            const campaignName = item?.name || item?.campaign?.name || item?.campaignName || null;
            const clubName = item?.club?.name || item?.clubName || null;
            const playlist = (item?.campaign?.playlist || item?.playlist || [])
                .map((p) => p?.mapUid)
                .filter(Boolean);

            if (clubId && campaignId) {
                out.push({ clubId, campaignId, updatedAt, playlist, campaignName, clubName });
            }
        }

        if (list.length < CLUB_LIST_BATCH) break;
        await new Promise((resolve) => setTimeout(resolve, 60));
    }

    return out.sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0)).slice(0, CLUB_MAX_CAMPAIGNS);
}

async function fetchClubCampaignPlaylist(accessToken, clubId, campaignId) {
    const url = `${LIVE_BASE}/api/token/club/${encodeURIComponent(clubId)}/campaign/${encodeURIComponent(campaignId)}`;

    try {
        const json = await jget(url, accessToken);
        const playlist = json?.campaign?.playlist || json?.playlist || [];
        const campaignName = json?.campaign?.name || json?.name || null;
        const clubName = json?.club?.name || json?.clubName || null;

        return playlist
            .map((p) => ({
                mapUid: p?.mapUid,
                campaignName,
                clubName,
            }))
            .filter((p) => p.mapUid);
    } catch {
        return [];
    }
}

async function computeUniversalMapIndex(accessToken, { includeClub = true } = {}) {
    const mapMeta = new Map();

    const [
        officialCampaigns,
        totdMonths,
        arcadeRooms,
        competitions,
        matchmakingMaps,
        liveEvents
    ] = await Promise.all([
        getOfficialCampaigns(accessToken),
        getTotdMonthsFromLive(accessToken),
        getArcadeRooms(accessToken),
        getCompetitions(accessToken),
        getMatchmakingMaps(accessToken),
        getLiveEvents(accessToken),
    ]);

    for (const campaign of officialCampaigns) {
        const campaignName = campaign?.name || campaign?.campaignName || null;
        const seasonUid = campaign?.seasonUid || null;

        for (const p of campaign?.playlist || []) {
            if (!p?.mapUid) continue;
            addMapMeta(mapMeta, p.mapUid, "official_campaign", {
                campaignName,
                seasonUid,
                name: p.name || p.mapName || null,
            });
        }
    }

    for (const month of totdMonths) {
        const monthName = month?.month || month?.name || null;
        const days = Array.isArray(month?.days) ? month.days : [];

        for (const day of days) {
            if (!day?.mapUid) continue;
            addMapMeta(mapMeta, day.mapUid, "totd", {
                month: monthName,
                date: day.date || day.day || null,
                name: day.name || day.mapName || null,
            });
        }
    }
    for (const room of arcadeRooms) {
        const maps = room?.playlist || room?.mapList || [];

        for (const map of maps) {
            if (!map?.mapUid) continue;

            addMapMeta(mapMeta, map.mapUid, "arcade", {
                roomName: room.name || null,
                name: map.name || map.mapName || null,
            });
        }
    }

    for (const comp of competitions) {
        const maps = comp?.playlist || comp?.mapList || [];

        for (const map of maps) {
            if (!map?.mapUid) continue;

            addMapMeta(mapMeta, map.mapUid, "competition", {
                competitionName: comp.name || null,
                name: map.name || map.mapName || null,
            });
        }
    }

    for (const map of matchmakingMaps) {
        if (!map?.mapUid) continue;

        addMapMeta(mapMeta, map.mapUid, "matchmaking", {
            name: map.name || map.mapName || null,
        });
    }

    for (const event of liveEvents) {
        const maps = event?.playlist || event?.mapList || [];

        for (const map of maps) {
            if (!map?.mapUid) continue;

            addMapMeta(mapMeta, map.mapUid, "live_event", {
                eventName: event.name || null,
                name: map.name || map.mapName || null,
            });
        }
    }

    let clubRefs = [];

    if (includeClub) {
        const disk = readJson(DISK_CLUB, null);
        const fresh =
            disk &&
            Date.now() - (disk.ts || 0) < CLUB_UID_TTL &&
            Array.isArray(disk.maps) &&
            disk.maps.length;

        if (fresh) {
            for (const item of disk.maps) {
                addMapMeta(mapMeta, item.mapUid, "club_campaign", item);
            }
        } else {
            clubRefs = await listAllClubCampaignRefsWithPlaylists(accessToken);
            const clubMaps = [];

            for (const ref of clubRefs) {
                if (ref.playlist?.length) {
                    for (const uid of ref.playlist) {
                        const item = {
                            mapUid: uid,
                            campaignName: ref.campaignName || null,
                            clubName: ref.clubName || null,
                            clubId: ref.clubId,
                            campaignId: ref.campaignId,
                        };
                        clubMaps.push(item);
                        addMapMeta(mapMeta, uid, "club_campaign", item);
                    }
                }
            }

            const missing = clubRefs.filter((r) => !r.playlist?.length);

            for (let i = 0; i < missing.length; i += CLUB_DETAIL_CONC) {
                const batch = missing.slice(i, i + CLUB_DETAIL_CONC);
                const results = await Promise.all(batch.map((r) => fetchClubCampaignPlaylist(accessToken, r.clubId, r.campaignId)));

                for (let j = 0; j < results.length; j++) {
                    const ref = batch[j];
                    for (const item of results[j] || []) {
                        const enriched = {
                            ...item,
                            campaignName: item.campaignName || ref.campaignName || null,
                            clubName: item.clubName || ref.clubName || null,
                            clubId: ref.clubId,
                            campaignId: ref.campaignId,
                        };
                        clubMaps.push(enriched);
                        addMapMeta(mapMeta, enriched.mapUid, "club_campaign", enriched);
                    }
                }

                await new Promise((resolve) => setTimeout(resolve, 80));
            }

            writeJson(DISK_CLUB, { ts: Date.now(), maps: clubMaps });
        }
    }

    for (const item of loadManualMaps()) {
        addMapMeta(mapMeta, item.mapUid, item.sourceType || "manual_event", item);
    }

    const maps = Array.from(mapMeta.values()).sort((a, b) => String(a.mapUid).localeCompare(String(b.mapUid)));

    const officialSet = new Set(maps.filter((m) => m.sources?.includes("official_campaign")).map((m) => m.mapUid));
    const totdSet = new Set(maps.filter((m) => m.sources?.includes("totd")).map((m) => m.mapUid));
    const clubSet = new Set(maps.filter((m) => m.sources?.includes("club_campaign")).map((m) => m.mapUid));
    const manualSet = new Set(maps.filter((m) => m.sources?.some((s) => s !== "official_campaign" && s !== "totd" && s !== "club_campaign")).map((m) => m.mapUid));

    metaCache = {
        allMapUids: maps.map((m) => m.mapUid),
        officialSet,
        totdSet,
        clubSet,
        manualSet,
        mapMeta,
    };

    writeJson(DISK_MAP_INDEX, {
        generatedAt: new Date().toISOString(),
        fetchedAt: Date.now(),
        total: maps.length,
        counts: getSourceCountsFromMaps(maps),
        maps,
    });

    return metaCache;
}

function getSourceCountsFromMaps(maps) {
    const counts = {};
    for (const map of maps || []) {
        counts[map.sourceType || "unknown"] = (counts[map.sourceType || "unknown"] || 0) + 1;
    }
    return counts;
}

async function getMapWR(accessToken, mapUid) {
    const url = `${LIVE_BASE}/api/token/leaderboard/group/Personal_Best/map/${encodeURIComponent(mapUid)}/top?onlyWorld=true&length=1`;

    try {
        const json = await jget(url, accessToken);
        const top = json?.tops?.[0]?.top?.[0];

        if (!top) return { mapUid, empty: true };

        const timeMs = Number(top.score);
        if (!isValidTimeMs(timeMs)) return { mapUid, empty: true };

        return {
            mapUid,
            accountId: top.accountId,
            timeMs,
            timestamp: normalizeToSeconds(top.timestamp),
        };
    } catch (error) {
        return { mapUid, error: error?.message || "leaderboard fetch failed" };
    }
}

async function resolveDisplayNames(_liveAccessToken, ids) {
    const all = Array.from(new Set((ids || []).filter(Boolean)));
    const need = all.filter((id) => !nameCache.has(id));

    if (!need.length) return nameCache;

    const oauthToken = await getOAuthToken();
    const chunkSize = 50;

    for (let i = 0; i < need.length; i += chunkSize) {
        const batch = need.slice(i, i + chunkSize);
        const params = new URLSearchParams();

        for (const id of batch) params.append("accountId[]", id);

        try {
            const response = await fetchWithTimeout(
                `https://api.trackmania.com/api/display-names?${params.toString()}`,
                {
                    headers: {
                        Authorization: `Bearer ${oauthToken}`,
                        Accept: "application/json",
                        "User-Agent": "trackmaniaevents.com/1.0",
                    },
                },
                15000
            );

            if (!response.ok) {
                for (const id of batch) if (!nameCache.has(id)) nameCache.set(id, id);
                continue;
            }

            const json = await response.json();

            for (const id of batch) {
                const displayName = json?.[id];
                nameCache.set(id, typeof displayName === "string" && displayName ? displayName : id);
            }
        } catch {
            for (const id of batch) if (!nameCache.has(id)) nameCache.set(id, id);
        }

        await new Promise((resolve) => setTimeout(resolve, 40));
    }

    return nameCache;
}

function inferSourceType(uid) {
    const meta = metaCache.mapMeta.get(uid);
    if (meta?.sourceType) return meta.sourceType;
    if (metaCache.officialSet.has(uid)) return "official_campaign";
    if (metaCache.totdSet.has(uid)) return "totd";
    if (metaCache.clubSet.has(uid)) return "club_campaign";
    if (metaCache.manualSet.has(uid)) return "manual_event";
    if (meta?.sources?.includes("arcade")) return "arcade";
    if (meta?.sources?.includes("competition")) return "competition";
    if (meta?.sources?.includes("matchmaking")) return "matchmaking";
    if (meta?.sources?.includes("live_event")) return "live_event";
    return "discovered";
}

async function fetchAllWRs(accessToken, mapUids) {
    const wrs = [];

    for (let i = 0; i < mapUids.length; i += WR_CONCURRENCY) {
        const batch = mapUids.slice(i, i + WR_CONCURRENCY);
        const part = await Promise.all(
            batch.map(async (uid) => {
                let row = sanitizeRow(await getMapWR(accessToken, uid));

                if (!row) {
                    await new Promise((resolve) => setTimeout(resolve, 60));
                    row = sanitizeRow(await getMapWR(accessToken, uid));
                }

                if (!row) return null;

                const meta = metaCache.mapMeta.get(uid);
                row.sourceType = inferSourceType(uid);
                row.sources = meta?.sources || [row.sourceType];
                row.mapName = meta?.name || null;
                row.campaignName = meta?.campaignName || meta?.campaign || null;
                row.clubName = meta?.clubName || null;
                row.event = meta?.event || null;
                row.tags = Array.isArray(meta?.tags) ? meta.tags : [];

                return row;
            })
        );

        wrs.push(...part.filter(Boolean));
    }

    return wrs;
}

function eventDateFile(timestampMs = Date.now()) {
    const date = new Date(timestampMs);
    const yyyy = date.getUTCFullYear();
    const mm = String(date.getUTCMonth() + 1).padStart(2, "0");
    const dd = String(date.getUTCDate()).padStart(2, "0");
    return path.join(WR_EVENTS_DIR, `${yyyy}-${mm}-${dd}.json`);
}

function appendWrEvent(event) {
    try {
        const file = eventDateFile(event.detectedAt || Date.now());
        const current = readJson(file, []);

        const exists = current.some(
            (x) =>
                x.mapUid === event.mapUid &&
                x.newHolderAccountId === event.newHolderAccountId &&
                x.newTimeMs === event.newTimeMs &&
                x.recordTimestamp === event.recordTimestamp
        );

        if (!exists) {
            current.push(event);
            writeJson(file, current);
        }
    } catch (error) {
        console.error("Failed to append WR event:", error?.message || error);
    }
}

function writeMapFile(row, oldRow = null) {
    if (!row?.mapUid) return;

    try {
        const file = path.join(MAPS_DIR, `${row.mapUid}.json`);
        const existing = readJson(file, null);
        const history = Array.isArray(existing?.history) ? existing.history : [];

        const currentSignature = `${row.accountId}:${row.timeMs}:${row.timestamp || 0}`;
        const lastSignature = history.length ? history[history.length - 1]?.signature : null;

        if (currentSignature !== lastSignature) {
            history.push({
                signature: currentSignature,
                accountId: row.accountId,
                displayName: row.displayName || row.accountId,
                timeMs: row.timeMs,
                timestamp: row.timestamp || 0,
                detectedAt: Date.now(),
            });
        }

        const meta = metaCache.mapMeta.get(row.mapUid) || {};

        writeJson(file, {
            mapUid: row.mapUid,
            name: row.mapName || meta.name || null,
            sourceType: row.sourceType,
            sources: row.sources || meta.sources || [row.sourceType],
            campaignName: row.campaignName || meta.campaignName || null,
            clubName: row.clubName || meta.clubName || null,
            event: row.event || meta.event || null,
            tags: row.tags || meta.tags || [],
            currentWR: {
                accountId: row.accountId,
                displayName: row.displayName || row.accountId,
                timeMs: row.timeMs,
                timestamp: row.timestamp || 0,
            },
            previousWR: oldRow
                ? {
                    accountId: oldRow.accountId,
                    displayName: oldRow.displayName || oldRow.accountId,
                    timeMs: oldRow.timeMs,
                    timestamp: oldRow.timestamp || 0,
                }
                : existing?.previousWR || null,
            updatedAt: Date.now(),
            history: history.slice(-250),
        });
    } catch (error) {
        console.error("Failed to write map file:", error?.message || error);
    }
}

function rebuildPlayerFiles(rows) {
    const grouped = new Map();

    for (const row of rows || []) {
        if (!row.accountId) continue;
        if (!grouped.has(row.accountId)) grouped.set(row.accountId, []);
        grouped.get(row.accountId).push(row);
    }

    for (const [accountId, wrs] of grouped.entries()) {
        wrs.sort((a, b) => (b.timestamp || 0) - (a.timestamp || 0));

        const bySource = {};
        for (const wr of wrs) bySource[wr.sourceType] = (bySource[wr.sourceType] || 0) + 1;

        writeJson(path.join(PLAYERS_DIR, `${accountId}.json`), {
            accountId,
            displayName: wrs[0]?.displayName || accountId,
            totalWRs: wrs.length,
            bySource,
            latestWR: wrs[0]
                ? {
                    mapUid: wrs[0].mapUid,
                    mapName: wrs[0].mapName || null,
                    timeMs: wrs[0].timeMs,
                    timestamp: wrs[0].timestamp || 0,
                    sourceType: wrs[0].sourceType,
                }
                : null,
            wrs: wrs.map((r) => ({
                mapUid: r.mapUid,
                mapName: r.mapName || null,
                timeMs: r.timeMs,
                timestamp: r.timestamp || 0,
                sourceType: r.sourceType,
                sources: r.sources || [r.sourceType],
                campaignName: r.campaignName || null,
                clubName: r.clubName || null,
                event: r.event || null,
            })),
            updatedAt: Date.now(),
        });
    }
}

function buildPlayerLeaderboard(rows) {
    const tally = new Map();

    for (const row of rows || []) {
        if (!row.accountId) continue;

        const rec = tally.get(row.accountId) || {
            accountId: row.accountId,
            displayName: row.displayName || row.accountId,
            wrCount: 0,
            latestTs: 0,
            bySource: {},
        };

        rec.wrCount += 1;
        rec.bySource[row.sourceType] = (rec.bySource[row.sourceType] || 0) + 1;
        if ((row.timestamp || 0) > rec.latestTs) rec.latestTs = row.timestamp || 0;

        tally.set(row.accountId, rec);
    }

    return Array.from(tally.values()).sort((a, b) => b.wrCount - a.wrCount || b.latestTs - a.latestTs);
}

function writeStaticOutputs(rows) {
    if (!AUTO_STATIC_WRITE) return;

    const safeRows = (rows || []).filter((r) => isValidTimeMs(Number(r.timeMs)));
    const leaderboard = buildPlayerLeaderboard(safeRows);
    const fetchedAt = wrCache.ts || Date.now();
    const generatedAt = new Date(fetchedAt).toISOString();

    const recentPayload = {
        rows: safeRows.slice(0, 1000),
        total: safeRows.length,
        fetchedAt,
        generatedAt,
        date: detroitDate(fetchedAt),
    };

    const playersPayload = {
        players: leaderboard.slice(0, 1000),
        total: leaderboard.length,
        fetchedAt,
        generatedAt,
        date: detroitDate(fetchedAt),
    };

    writeJson(path.join(FEEDS_DIR, "recent-wrs.json"), recentPayload);
    writeJson(path.join(RECENT_WRS_DIR, "latest.json"), recentPayload);
    writeJson(path.join(LEADERBOARDS_DIR, "global.json"), playersPayload);
    writeJson(path.join(WR_LEADERBOARD_DIR, "latest.json"), playersPayload);

    for (const row of safeRows) writeMapFile(row);
    rebuildPlayerFiles(safeRows);
}

function swapCache(rows) {
    rows.sort((a, b) => (b.timestamp || 0) - (a.timestamp || 0));
    wrCache = { ts: Date.now(), rows };
    writeJson(DISK_WR, wrCache, false);
    writeStaticOutputs(rows);
    respCache.clear();
}

function diffAndMergeByMap(oldRows, newRows) {
    const byOld = new Map((oldRows || []).map((row) => [row.mapUid, row]));
    const byNew = new Map((newRows || []).map((row) => [row.mapUid, row]));
    const updated = [];

    for (const [uid, next] of byNew.entries()) {
        const old = byOld.get(uid);
        const changed =
            !old ||
            old.accountId !== next.accountId ||
            old.timeMs !== next.timeMs ||
            (old.timestamp || 0) !== (next.timestamp || 0);

        if (!changed) continue;

        updated.push(next);

        if (old) {
            appendWrEvent({
                type: old.accountId === next.accountId ? "self_improve" : "wr_takeover",
                mapUid: uid,
                mapName: next.mapName || old.mapName || null,
                sourceType: next.sourceType,
                sources: next.sources || [next.sourceType],
                campaignName: next.campaignName || null,
                clubName: next.clubName || null,
                event: next.event || null,
                oldHolder: old.displayName || old.accountId || null,
                oldHolderAccountId: old.accountId || null,
                oldTimeMs: old.timeMs || null,
                oldTimestamp: old.timestamp || 0,
                newHolder: next.displayName || next.accountId,
                newHolderAccountId: next.accountId,
                newTimeMs: next.timeMs,
                recordTimestamp: next.timestamp || 0,
                detectedAt: Date.now(),
            });
        } else {
            appendWrEvent({
                type: "new_wr_seen",
                mapUid: uid,
                mapName: next.mapName || null,
                sourceType: next.sourceType,
                sources: next.sources || [next.sourceType],
                campaignName: next.campaignName || null,
                clubName: next.clubName || null,
                event: next.event || null,
                oldHolder: null,
                oldHolderAccountId: null,
                oldTimeMs: null,
                newHolder: next.displayName || next.accountId,
                newHolderAccountId: next.accountId,
                newTimeMs: next.timeMs,
                recordTimestamp: next.timestamp || 0,
                detectedAt: Date.now(),
            });
        }

        writeMapFile(next, old || null);
    }

    const mergedMap = new Map(byOld);

    for (const row of updated) {
        mergedMap.set(row.mapUid, row);
    }

    const merged = Array.from(mergedMap.values()).sort((a, b) => (b.timestamp || 0) - (a.timestamp || 0));

    return { merged, updatedCount: updated.length, updated };
}

async function buildAllWRs({ includeClub = INCLUDE_CLUB_BY_DEFAULT } = {}) {
    const accessToken = await getLiveAccessToken();
    const meta = await computeUniversalMapIndex(accessToken, { includeClub });
    const wrs = await fetchAllWRs(accessToken, meta.allMapUids);

    const ids = wrs.map((row) => row.accountId).filter(Boolean);
    await resolveDisplayNames(accessToken, ids);

    for (const row of wrs) {
        row.displayName = nameCache.get(row.accountId) || row.accountId;
    }

    swapCache(wrs);
    return wrCache.rows;
}

async function rebuildNow({ includeClub = INCLUDE_CLUB_BY_DEFAULT } = {}) {
    const accessToken = await getLiveAccessToken();

    const meta = await computeUniversalMapIndex(accessToken, { includeClub });
    const newRows = await fetchAllWRs(accessToken, meta.allMapUids);

    const ids = newRows.map((row) => row.accountId).filter(Boolean);
    await resolveDisplayNames(accessToken, ids);

    for (const row of newRows) {
        row.displayName = nameCache.get(row.accountId) || row.accountId;
    }

    const { merged, updatedCount, updated } = diffAndMergeByMap(wrCache.rows || [], newRows);

    wrCache = { ts: Date.now(), rows: merged };
    writeJson(DISK_WR, wrCache, false);
    writeStaticOutputs(merged);
    respCache.clear();

    return {
        updated: updatedCount,
        updatedRows: updated.slice(0, 50),
        total: merged.length,
        mapUniverse: meta.allMapUids.length,
        counts: getWrCountsBySource(merged),
    };
}

function getWrCountsBySource(rows) {
    const counts = {};
    for (const row of rows || []) {
        counts[row.sourceType || "unknown"] = (counts[row.sourceType || "unknown"] || 0) + 1;
    }
    return counts;
}

async function quickRefreshRecent({ count = QUICK_REFRESH_COUNT } = {}) {
    if (!wrCache.rows.length) return { changed: 0 };

    const accessToken = await getLiveAccessToken();
    const recent = wrCache.rows.slice(0, Math.min(count, wrCache.rows.length));

    const refreshed = await Promise.all(
        recent.map(async (old) => {
            const row = sanitizeRow(await getMapWR(accessToken, old.mapUid));
            if (!row) return null;

            row.sourceType = old.sourceType;
            row.sources = old.sources || [old.sourceType];
            row.mapName = old.mapName || null;
            row.campaignName = old.campaignName || null;
            row.clubName = old.clubName || null;
            row.event = old.event || null;
            row.tags = old.tags || [];

            return row;
        })
    );

    const fresh = refreshed.filter(Boolean);
    const ids = fresh.map((row) => row.accountId).filter(Boolean);
    await resolveDisplayNames(accessToken, ids);

    for (const row of fresh) {
        row.displayName = nameCache.get(row.accountId) || row.accountId;
    }

    const { merged, updatedCount } = diffAndMergeByMap(wrCache.rows || [], fresh);

    if (updatedCount) {
        wrCache = { ts: Date.now(), rows: merged };
        writeJson(DISK_WR, wrCache, false);
        writeStaticOutputs(merged);
        respCache.clear();
    }

    return { changed: updatedCount };
}

async function maybeRefreshUidUniverse() {
    if (!AUTO_UID_REFRESH) return { added: 0 };

    const accessToken = await getLiveAccessToken();
    const before = new Set(metaCache.allMapUids || []);
    const meta = await computeUniversalMapIndex(accessToken, { includeClub: INCLUDE_CLUB_BY_DEFAULT });
    const after = new Set(meta.allMapUids || []);
    const newUids = Array.from(after).filter((uid) => !before.has(uid));

    if (!newUids.length) return { added: 0 };

    const rows = await fetchAllWRs(accessToken, newUids);
    const ids = rows.map((row) => row.accountId).filter(Boolean);
    await resolveDisplayNames(accessToken, ids);

    for (const row of rows) {
        row.displayName = nameCache.get(row.accountId) || row.accountId;
    }

    const { merged, updatedCount } = diffAndMergeByMap(wrCache.rows || [], rows);

    if (updatedCount) {
        wrCache = { ts: Date.now(), rows: merged };
        writeJson(DISK_WR, wrCache, false);
        writeStaticOutputs(merged);
        respCache.clear();
    }

    return { added: newUids.length, updated: updatedCount };
}

function makeDebounced(fn, waitMs) {
    let last = 0;
    let running = false;
    let pending = false;

    return async function wrapped(...args) {
        const now = Date.now();

        if (running) {
            pending = true;
            return;
        }

        if (now - last < waitMs) return;

        running = true;

        try {
            await fn(...args);
        } finally {
            last = Date.now();
            running = false;

            if (pending) {
                pending = false;
                wrapped(...args);
            }
        }
    };
}

const debouncedQuickRefresh = makeDebounced(() => quickRefreshRecent({ count: QUICK_REFRESH_COUNT }), 15_000);
const debouncedUidRefresh = makeDebounced(() => maybeRefreshUidUniverse(), 60_000);

function warmStart() {
    const disk = readJson(DISK_WR, null);
    if (disk && Array.isArray(disk.rows) && disk.rows.length) {
        wrCache = { ts: disk.ts || Date.now(), rows: disk.rows };
    }

    const mapIndex = readJson(DISK_MAP_INDEX, null);
    if (mapIndex && Array.isArray(mapIndex.maps)) {
        const mapMeta = new Map();

        for (const item of mapIndex.maps) {
            if (item.mapUid) mapMeta.set(item.mapUid, item);
        }

        metaCache = {
            allMapUids: mapIndex.maps.map((m) => m.mapUid).filter(Boolean),
            officialSet: new Set(mapIndex.maps.filter((m) => m.sources?.includes("official_campaign")).map((m) => m.mapUid)),
            totdSet: new Set(mapIndex.maps.filter((m) => m.sources?.includes("totd")).map((m) => m.mapUid)),
            clubSet: new Set(mapIndex.maps.filter((m) => m.sources?.includes("club_campaign")).map((m) => m.mapUid)),
            manualSet: new Set(mapIndex.maps.filter((m) => m.sourceType === "manual_event" || m.sources?.includes("manual_event")).map((m) => m.mapUid)),
            mapMeta,
        };
    }
}

async function warmBuildInBackground() {
    if (building) return;
    if (wrCache.rows.length && metaCache.allMapUids.length) return;

    try {
        building = true;
        await buildAllWRs({ includeClub: INCLUDE_CLUB_BY_DEFAULT });
    } catch (error) {
        console.error("Warm build failed:", error?.message || error);
    } finally {
        building = false;
    }
}

async function ensureCacheOnce(_req, res, next) {
    try {
        if (!wrCache.rows.length) {
            await buildAllWRs({ includeClub: INCLUDE_CLUB_BY_DEFAULT });
        }
        next();
    } catch (error) {
        res.status(503).json({ error: "AuthUnavailable", detail: error?.message || String(error) });
    }
}

app.use((req, res, next) => {
    if (
        req.path === "/totd.json" ||
        req.path.startsWith("/data/totd/") ||
        req.path.startsWith("/data/feeds/") ||
        req.path.startsWith("/data/leaderboards/") ||
        req.path.startsWith("/data/recent-wrs/") ||
        req.path.startsWith("/data/wr-leaderboard/")
    ) {
        res.setHeader("Cache-Control", "public, max-age=15, stale-while-revalidate=300");
    }
    next();
});

app.use(express.static(PUBLIC_DIR));

app.get("/", (_req, res) => res.send("OK"));
app.get("/healthz", (_req, res) => res.json({ ok: true }));

app.get("/api/ready", (_req, res) => {
    res.setHeader("Cache-Control", "no-store");
    res.json({
        ok: !!wrCache.rows.length,
        building,
        rows: wrCache.rows.length,
        mapUniverse: metaCache.allMapUids.length,
        fetchedAt: wrCache.ts || null,
        counts: getWrCountsBySource(wrCache.rows),
    });
});

app.post("/api/admin/set-refresh", (req, res) => {
    res.setHeader("Cache-Control", "no-store");

    const auth = req.headers["x-admin-secret"] || req.query.secret;
    if (!ADMIN_SECRET || auth !== ADMIN_SECRET) {
        return res.status(403).json({ ok: false, error: "forbidden" });
    }

    const cleaned = cleanToken(req.body?.token || "");
    if (!cleaned) return res.status(400).json({ ok: false, error: "missing token" });

    persistRefreshToken(cleaned);
    cachedAccess = { token: null, expAt: 0 };
    res.json({ ok: true });
});

app.post("/api/rebuild-now", async (req, res) => {
    res.setHeader("Cache-Control", "no-store");

    try {
        const includeClubParam = String(req.query.includeClub ?? "").toLowerCase();
        const includeClub = includeClubParam === "true" ? true : includeClubParam === "false" ? false : INCLUDE_CLUB_BY_DEFAULT;

        const result = await rebuildNow({ includeClub });
        res.json({ ok: true, fetchedAt: wrCache.ts, ...result });
    } catch (error) {
        res.status(500).json({ error: error?.message || String(error) });
    }
});

app.post("/api/refresh-recent", ensureCacheOnce, async (_req, res) => {
    res.setHeader("Cache-Control", "no-store");

    try {
        const result = await quickRefreshRecent({ count: QUICK_REFRESH_COUNT });
        res.json({ ok: true, ...result, fetchedAt: wrCache.ts });
    } catch (error) {
        res.status(500).json({ error: error?.message || String(error) });
    }
});

app.get("/api/map-index", ensureCacheOnce, async (req, res) => {
    try {
        debouncedUidRefresh();

        const maps = Array.from(metaCache.mapMeta.values());
        const payload = {
            total: maps.length,
            counts: getSourceCountsFromMaps(maps),
            fetchedAt: wrCache.ts,
            maps,
        };

        sendJsonETag(req, res, payload, { maxAge: 10, stale: 300 });
    } catch (error) {
        res.status(500).json({ error: error?.message || String(error) });
    }
});

app.get("/api/wr-latest", ensureCacheOnce, async (req, res) => {
    const cached = getCached(req);
    if (cached) {
        res.setHeader("Cache-Control", "public, max-age=3, stale-while-revalidate=60");
        return res.json(cached);
    }

    try {
        debouncedUidRefresh();
        debouncedQuickRefresh();

        let out = (wrCache.rows || []).filter((row) => isValidTimeMs(Number(row.timeMs)));

        const limit = Math.max(1, Math.min(5000, Number(req.query.limit) || 300));
        const search = String(req.query.search || "").trim().toLowerCase();
        const type = String(req.query.type || "all").trim().toLowerCase();

        if (search) {
            out = out.filter(
                (row) =>
                    row.displayName?.toLowerCase().includes(search) ||
                    row.accountId?.toLowerCase().includes(search) ||
                    row.mapUid?.toLowerCase().includes(search) ||
                    row.mapName?.toLowerCase().includes(search) ||
                    row.campaignName?.toLowerCase().includes(search) ||
                    row.clubName?.toLowerCase().includes(search) ||
                    row.event?.toLowerCase().includes(search)
            );
        }

        if (type !== "all") {
            const allowed = new Set(type.split(",").map((s) => s.trim()).filter(Boolean));
            out = out.filter((row) => allowed.has(row.sourceType) || row.sources?.some((source) => allowed.has(source)));
        }

        const payload = {
            rows: out.slice(0, limit),
            total: out.length,
            fetchedAt: wrCache.ts,
            generatedAt: new Date(wrCache.ts || Date.now()).toISOString(),
            date: detroitDate(wrCache.ts || Date.now()),
        };

        setCached(req, payload);
        res.setHeader("Cache-Control", "public, max-age=3, stale-while-revalidate=60");
        res.json(payload);
    } catch (error) {
        console.error("wr-latest:", error);
        res.status(500).json({ error: "Failed to load latest world records", detail: error?.message || String(error) });
    }
});

app.get("/api/wr-players", ensureCacheOnce, async (req, res) => {
    const cached = getCached(req);
    if (cached) {
        res.setHeader("Cache-Control", "public, max-age=3, stale-while-revalidate=60");
        return res.json(cached);
    }

    try {
        debouncedUidRefresh();
        debouncedQuickRefresh();

        const q = String(req.query.q || "").trim().toLowerCase();
        const type = String(req.query.type || "all").trim().toLowerCase();
        const limit = Math.max(1, Math.min(5000, Number(req.query.limit) || 200));

        let rows = (wrCache.rows || []).filter((row) => isValidTimeMs(Number(row.timeMs)));

        if (type !== "all") {
            const allowed = new Set(type.split(",").map((s) => s.trim()).filter(Boolean));
            rows = rows.filter((row) => allowed.has(row.sourceType) || row.sources?.some((source) => allowed.has(source)));
        }

        let players = buildPlayerLeaderboard(rows);

        if (q) {
            players = players.filter(
                (player) => player.displayName?.toLowerCase().includes(q) || player.accountId?.toLowerCase().includes(q)
            );
        }

        const payload = {
            players: players.slice(0, limit),
            total: players.length,
            fetchedAt: wrCache.ts,
            generatedAt: new Date(wrCache.ts || Date.now()).toISOString(),
            date: detroitDate(wrCache.ts || Date.now()),
        };

        setCached(req, payload);
        res.setHeader("Cache-Control", "public, max-age=3, stale-while-revalidate=60");
        res.json(payload);
    } catch (error) {
        console.error("wr-players:", error);
        res.status(500).json({ error: "Failed to load WR players", detail: error?.message || String(error) });
    }
});

app.get("/api/player/:accountId", ensureCacheOnce, async (req, res) => {
    try {
        const accountId = req.params.accountId;
        const file = path.join(PLAYERS_DIR, `${accountId}.json`);
        const payload = readJson(file, null);

        if (payload) return sendJsonETag(req, res, payload, { maxAge: 30, stale: 300 });

        const rows = (wrCache.rows || []).filter((row) => row.accountId === accountId);
        if (!rows.length) return res.status(404).json({ error: "Player not found" });

        rebuildPlayerFiles(wrCache.rows);
        const rebuilt = readJson(file, null);
        if (!rebuilt) return res.status(404).json({ error: "Player not found" });

        sendJsonETag(req, res, rebuilt, { maxAge: 30, stale: 300 });
    } catch (error) {
        res.status(500).json({ error: error?.message || String(error) });
    }
});

app.get("/api/map/:mapUid", ensureCacheOnce, async (req, res) => {
    try {
        const mapUid = req.params.mapUid;
        const file = path.join(MAPS_DIR, `${mapUid}.json`);
        const payload = readJson(file, null);

        if (payload) return sendJsonETag(req, res, payload, { maxAge: 30, stale: 300 });

        const row = (wrCache.rows || []).find((item) => item.mapUid === mapUid);
        if (!row) return res.status(404).json({ error: "Map not found" });

        writeMapFile(row);
        const rebuilt = readJson(file, null);
        if (!rebuilt) return res.status(404).json({ error: "Map not found" });

        sendJsonETag(req, res, rebuilt, { maxAge: 30, stale: 300 });
    } catch (error) {
        res.status(500).json({ error: error?.message || String(error) });
    }
});

app.get("/api/wr-events", async (req, res) => {
    try {
        const limit = Math.max(1, Math.min(1000, Number(req.query.limit) || 100));
        const files = fs
            .readdirSync(WR_EVENTS_DIR)
            .filter((file) => file.endsWith(".json"))
            .sort()
            .reverse();

        const events = [];

        for (const file of files) {
            const rows = readJson(path.join(WR_EVENTS_DIR, file), []);
            events.push(...rows.reverse());
            if (events.length >= limit) break;
        }

        res.setHeader("Cache-Control", "public, max-age=10, stale-while-revalidate=300");
        res.json({ events: events.slice(0, limit), total: events.length });
    } catch (error) {
        res.status(500).json({ error: error?.message || String(error) });
    }
});

app.get("/api/top-weekly", ensureCacheOnce, async (req, res) => {
    const cached = getCached(req);
    if (cached) {
        res.setHeader("Cache-Control", "public, max-age=5, stale-while-revalidate=60");
        return res.json(cached);
    }

    try {
        debouncedUidRefresh();
        debouncedQuickRefresh();

        const days = Math.max(1, Math.min(90, Number(req.query.days) || 7));
        const limit = Math.max(1, Math.min(50, Number(req.query.limit) || 3));
        const cutoff = Math.floor(Date.now() / 1000) - days * 24 * 3600;

        const tally = new Map();

        for (const row of wrCache.rows || []) {
            if (!row.accountId || !row.timestamp || row.timestamp < cutoff) continue;
            if (!isValidTimeMs(Number(row.timeMs))) continue;

            const rec = tally.get(row.accountId) || {
                accountId: row.accountId,
                displayName: row.displayName || row.accountId,
                wrs: 0,
                bySource: {},
                latestTs: 0,
            };

            rec.wrs += 1;
            rec.bySource[row.sourceType] = (rec.bySource[row.sourceType] || 0) + 1;
            if (row.timestamp > rec.latestTs) rec.latestTs = row.timestamp;

            tally.set(row.accountId, rec);
        }

        const top = Array.from(tally.values())
            .sort((a, b) => b.wrs - a.wrs || b.latestTs - a.latestTs)
            .slice(0, limit)
            .map((item, index) => ({
                ...item,
                rank: index + 1,
                player: item.displayName,
                name: item.displayName,
                count: item.wrs,
                wrCount: item.wrs,
            }));

        const payload = {
            rangeDays: days,
            days,
            top,
            podium: top.slice(0, 3),
            generatedAt: Date.now(),
            fetchedAt: wrCache.ts,
        };

        setCached(req, payload);
        res.setHeader("Cache-Control", "public, max-age=5, stale-while-revalidate=60");
        res.json(payload);
    } catch (error) {
        res.status(500).json({ error: error?.message || String(error) });
    }
});

app.get("/api/top-monthly", ensureCacheOnce, async (req, res) => {
    try {
        debouncedUidRefresh();
        debouncedQuickRefresh();

        const ym = String(req.query.ym || "").trim();
        if (!ym) return res.status(400).json({ error: "Missing ym (YYYY-MM)" });

        const [year, month] = ym.split("-").map(Number);
        const start = new Date(Date.UTC(year, month - 1, 1)).getTime() / 1000;
        const end = new Date(Date.UTC(year, month, 1)).getTime() / 1000;

        const rows = (wrCache.rows || []).filter(
            (row) => isValidTimeMs(Number(row.timeMs)) && row.timestamp >= start && row.timestamp < end
        );

        const tally = new Map();

        for (const row of rows) {
            if (!row.accountId) continue;

            const rec = tally.get(row.accountId) || {
                accountId: row.accountId,
                displayName: row.displayName || row.accountId,
                wrs: 0,
                latestTs: 0,
            };

            rec.wrs += 1;
            if (row.timestamp > rec.latestTs) rec.latestTs = row.timestamp;
            tally.set(row.accountId, rec);
        }

        const top = Array.from(tally.values()).sort((a, b) => b.wrs - a.wrs || b.latestTs - a.latestTs).slice(0, 3);

        res.setHeader("Cache-Control", "public, max-age=30, stale-while-revalidate=300");
        res.json({ ym, top });
    } catch (error) {
        res.status(500).json({ error: error?.message || String(error) });
    }
});

process.on("unhandledRejection", (error) => console.error("UNHANDLED_REJECTION:", error));
process.on("uncaughtException", (error) => console.error("UNCAUGHT_EXCEPTION:", error));

warmStart();
warmBuildInBackground();

setInterval(() => warmBuildInBackground(), 30 * 60 * 1000);
setInterval(() => getLiveAccessToken().catch(() => { }), 6 * 60 * 60 * 1000);
setInterval(() => debouncedQuickRefresh(), 60 * 1000);
setInterval(() => debouncedUidRefresh(), 10 * 60 * 1000);

const PORT = process.env.PORT || 3000;
app.listen(PORT, "0.0.0.0", () => {
    console.log(`✅ Trackmania Events WR engine running on port ${PORT}`);
});
