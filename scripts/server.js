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
const CORE_REFRESH_URL =
    "https://prod.trackmania.core.nadeo.online/v2/authentication/token/refresh";

const REFRESH_TOKEN_FILE =
    process.env.REFRESH_TOKEN_FILE || "/data/nadeo_refresh_token.txt";

const OAUTH_CLIENT_ID = process.env.CLIENT_ID;
const OAUTH_CLIENT_SECRET = process.env.CLIENT_SECRET;
const ADMIN_SECRET = process.env.ADMIN_SECRET;

const WR_CONCURRENCY = Math.max(
    1,
    Number(process.env.WR_CONCURRENCY || 8)
);

const CLUB_LIST_BATCH = Math.max(
    1,
    Number(process.env.CLUB_LIST_BATCH || 100)
);

const CLUB_DETAIL_CONC = Math.max(
    1,
    Number(process.env.CLUB_DETAIL_CONC || 4)
);

const CLUB_MAX_CAMPAIGNS = Math.max(
    1,
    Number(process.env.CLUB_MAX_CAMPAIGNS || 500)
);

const CLUB_UID_TTL =
    Math.max(1, Number(process.env.CLUB_UID_TTL_HOURS || 24)) *
    3600 *
    1000;

const QUICK_REFRESH_COUNT = Math.max(
    1,
    Number(process.env.QUICK_REFRESH_COUNT || 200)
);

const RESPONSE_TTL_SECONDS = Math.max(
    0,
    Number(process.env.RESPONSE_TTL_SECONDS || 3)
);

const MAX_WR_MS = Math.max(
    1,
    Number(process.env.MAX_WR_MS || 24 * 3600 * 1000)
);

const AUTO_UID_REFRESH =
    (process.env.AUTO_UID_REFRESH ?? "true").toLowerCase() ===
    "true";

const AUTO_STATIC_WRITE =
    (process.env.AUTO_STATIC_WRITE ?? "true").toLowerCase() ===
    "true";

const INCLUDE_CLUB_BY_DEFAULT =
    (process.env.INCLUDE_CLUB_BY_DEFAULT ?? "true").toLowerCase() ===
    "true";

const DISK_WR =
    process.env.CACHE_PATH_WR || "/tmp/wr_cache.json";

const DISK_CLUB =
    process.env.CACHE_PATH_CLUB || "/tmp/club_uids.json";

const DISK_MAP_INDEX =
    process.env.CACHE_PATH_MAP_INDEX ||
    path.join(METADATA_DIR, "map-index.json");

const MANUAL_MAPS_FILE =
    process.env.MANUAL_MAPS_FILE ||
    path.join(METADATA_DIR, "manual-maps.json");
const WEEKLY_SHORTS_DIR =
    path.join(DATA_ROOT, "weekly-shorts");

const WEEKLY_GRANDS_DIR =
    path.join(DATA_ROOT, "weekly-grands");

const TMX_CACHE_FILE =
    path.join(METADATA_DIR, "tmx-maps.json");

const TMX_PAGE_LIMIT = Math.max(
    1,
    Number(process.env.TMX_PAGE_LIMIT || 25)
);

const TMX_ENABLE =
    (process.env.TMX_ENABLE ?? "true").toLowerCase() ===
    "true";

let runtimeRefreshToken = cleanToken(
    process.env.REFRESH_TOKEN || ""
);

let cachedAccess = {
    token: null,
    expAt: 0,
};

let cachedOAuth = {
    token: null,
    expAt: 0,
};

let wrCache = {
    ts: 0,
    rows: [],
};

let metaCache = {
    allMapUids: [],
    officialSet: new Set(),
    totdSet: new Set(),
    clubSet: new Set(),
    shortsSet: new Set(),
    grandsSet: new Set(),
    tmxSet: new Set(),
    manualSet: new Set(),
    mapMeta: new Map(),
};

const nameCache = new Map();
const respCache = new Map();

let building = false;

function cleanToken(value) {
    if (!value) return "";

    let token = String(value).trim();

    if (token.toLowerCase().startsWith("nadeo_v1 t=")) {
        token = token
            .slice("nadeo_v1 t=".length)
            .trim();
    }

    if (
        (token.startsWith('"') && token.endsWith('"')) ||
        (token.startsWith("'") && token.endsWith("'"))
    ) {
        token = token.slice(1, -1);
    }

    return token;
}

function readJson(filePath, fallback = null) {
    try {
        if (!fs.existsSync(filePath)) return fallback;

        return JSON.parse(
            fs.readFileSync(filePath, "utf8")
        );
    } catch {
        return fallback;
    }
}

function writeJson(filePath, payload, pretty = true) {
    fs.mkdirSync(path.dirname(filePath), {
        recursive: true,
    });

    fs.writeFileSync(
        filePath,
        JSON.stringify(payload, null, pretty ? 2 : 0)
    );
}
function getRefreshToken() {
    try {
        if (fs.existsSync(REFRESH_TOKEN_FILE)) {
            const token = cleanToken(
                fs.readFileSync(
                    REFRESH_TOKEN_FILE,
                    "utf8"
                )
            );

            if (token) return token;
        }
    } catch { }

    return runtimeRefreshToken;
}

function persistRefreshToken(refreshToken) {
    const cleaned = cleanToken(refreshToken);

    if (!cleaned) return;

    try {
        fs.mkdirSync(
            path.dirname(REFRESH_TOKEN_FILE),
            { recursive: true }
        );

        fs.writeFileSync(
            REFRESH_TOKEN_FILE,
            cleaned,
            "utf8"
        );

        runtimeRefreshToken = cleaned;
    } catch (error) {
        console.error(
            "Failed to persist refresh token:",
            error?.message || error
        );
    }
}

function fetchWithTimeout(
    url,
    opts = {},
    ms = 15000
) {
    const controller = new AbortController();

    const timeout = setTimeout(
        () => controller.abort(),
        ms
    );

    return baseFetch(url, {
        ...opts,
        signal: controller.signal,
    }).finally(() => clearTimeout(timeout));
}

async function getLiveAccessToken() {
    const now = Date.now();

    if (
        cachedAccess.token &&
        now < cachedAccess.expAt - 30000
    ) {
        return cachedAccess.token;
    }

    const refreshToken = getRefreshToken();

    if (!refreshToken) {
        throw new Error("Missing REFRESH_TOKEN");
    }

    const response = await fetchWithTimeout(
        CORE_REFRESH_URL,
        {
            method: "POST",
            headers: {
                Authorization: `nadeo_v1 t=${refreshToken}`,
                "Content-Type": "application/json",
                "User-Agent":
                    "trackmaniaevents.com/1.0",
            },
            body: "{}",
        },
        15000
    );

    if (!response.ok) {
        const body = await response
            .text()
            .catch(() => "");

        throw new Error(
            `refresh failed ${response.status} ${body || "(no body)"
            }`
        );
    }

    const json = await response.json();

    const accessToken =
        json.accessToken || json.access_token;

    const expiresIn =
        json.expiresIn ||
        json.expires_in ||
        3600;

    const newRefreshToken =
        json.refreshToken ||
        json.refresh_token;

    if (!accessToken) {
        throw new Error(
            "No access token returned from Nadeo refresh."
        );
    }

    if (
        typeof newRefreshToken === "string" &&
        newRefreshToken.trim()
    ) {
        persistRefreshToken(newRefreshToken);
    }

    cachedAccess = {
        token: accessToken,
        expAt:
            Date.now() + expiresIn * 1000,
    };

    return cachedAccess.token;
}

async function getOAuthToken() {
    const now = Date.now();

    if (
        cachedOAuth.token &&
        now < cachedOAuth.expAt - 30000
    ) {
        return cachedOAuth.token;
    }

    if (
        !OAUTH_CLIENT_ID ||
        !OAUTH_CLIENT_SECRET
    ) {
        throw new Error(
            "Missing CLIENT_ID / CLIENT_SECRET"
        );
    }

    const response = await fetchWithTimeout(
        "https://api.trackmania.com/api/access_token",
        {
            method: "POST",
            headers: {
                "Content-Type":
                    "application/x-www-form-urlencoded",
                "User-Agent":
                    "trackmaniaevents.com/1.0",
            },
            body: new URLSearchParams({
                grant_type:
                    "client_credentials",
                client_id:
                    OAUTH_CLIENT_ID,
                client_secret:
                    OAUTH_CLIENT_SECRET,
            }).toString(),
        },
        15000
    );

    if (!response.ok) {
        throw new Error(
            `OAuth token failed ${response.status
            } ${await response.text()}`
        );
    }

    const json = await response.json();

    const accessToken =
        json.access_token ||
        json.accessToken;

    const expiresIn =
        json.expires_in || 3600;

    if (!accessToken) {
        throw new Error(
            "No OAuth access token returned."
        );
    }

    cachedOAuth = {
        token: accessToken,
        expAt:
            Date.now() + expiresIn * 1000,
    };

    return cachedOAuth.token;
}

async function jget(url, accessToken) {
    const response = await fetchWithTimeout(
        url,
        {
            headers: {
                Authorization:
                    `nadeo_v1 t=${accessToken}`,
                "User-Agent":
                    "trackmaniaevents.com/1.0",
                Accept:
                    "application/json",
            },
        },
        15000
    );

    // FIXED:
    // dead endpoints no longer crash the entire build

    if (!response.ok) {
        const text = await response
            .text()
            .catch(() => "");

        console.error(
            `JGET FAILED: ${url} -> ${response.status} ${text}`
        );

        return {};
    }

    return response.json();
}

function sendJsonETag(
    req,
    res,
    obj,
    opts = {}
) {
    const {
        maxAge = 60,
        stale = 300,
        noStore = false,
    } = opts;

    const body = JSON.stringify(obj);

    const etag = `"${crypto
        .createHash("sha1")
        .update(body)
        .digest("hex")}"`;

    res.setHeader("ETag", etag);

    res.setHeader(
        "Cache-Control",
        noStore
            ? "no-store"
            : `public, max-age=${Math.max(
                0,
                maxAge
            )}, stale-while-revalidate=${Math.max(
                0,
                stale
            )}`
    );

    if (
        req.headers["if-none-match"] ===
        etag
    ) {
        return res.status(304).end();
    }

    res.type("application/json").send(body);
}

function cacheKey(req) {
    return req.originalUrl || req.url;
}

function getCached(req) {
    const key = cacheKey(req);

    const item = respCache.get(key);

    if (!item) return null;

    if (
        Date.now() - item.ts >
        RESPONSE_TTL_SECONDS * 1000
    ) {
        respCache.delete(key);
        return null;
    }

    return item.body;
}

function setCached(req, payload) {
    const key = cacheKey(req);

    respCache.set(key, {
        ts: Date.now(),
        body: payload,
    });

    if (respCache.size > 200) {
        const first =
            respCache.keys().next().value;

        if (first) {
            respCache.delete(first);
        }
    }
}
function normalizeToSeconds(value) {
    if (value == null) return 0;

    const number = Number(value);

    if (Number.isFinite(number)) {
        return number > 1e12
            ? Math.round(number / 1000)
            : Math.round(number);
    }

    const parsed = Date.parse(String(value));

    if (Number.isFinite(parsed)) {
        return parsed > 1e12
            ? Math.round(parsed / 1000)
            : Math.round(parsed);
    }

    return 0;
}

function isValidTimeMs(ms) {
    return (
        Number.isFinite(ms) &&
        ms > 0 &&
        ms < MAX_WR_MS
    );
}

function sanitizeRow(row) {
    if (!row || row.empty || row.error) {
        return null;
    }

    const timeMs = Number(row.timeMs);

    if (!isValidTimeMs(timeMs)) {
        return null;
    }

    if (
        !row.accountId ||
        typeof row.accountId !== "string"
    ) {
        return null;
    }

    if (
        !row.mapUid ||
        typeof row.mapUid !== "string"
    ) {
        return null;
    }

    return {
        ...row,
        timeMs,
    };
}

function detroitDate(tsMs) {
    return new Intl.DateTimeFormat(
        "en-CA",
        {
            timeZone:
                "America/Detroit",
            year: "numeric",
            month: "2-digit",
            day: "2-digit",
        }
    )
        .format(new Date(tsMs))
        .replaceAll("/", "-");
}

function mapSourcePriority(
    sourceType
) {
    const order = {
        manual_event: 120,
        weekly_grands: 115,
        weekly_shorts: 110,
        official_campaign: 100,
        totd: 90,
        club_campaign: 80,
        arcade: 70,
        tmx: 60,
        discovered: 10,
    };

    return (
        order[sourceType] || 0
    );
}

function addMapMeta(
    map,
    uid,
    sourceType,
    extra = {}
) {
    if (!uid) return;

    const existing =
        map.get(uid);

    const next = {
        mapUid: uid,
        sourceType,
        sources: Array.from(
            new Set([
                ...(existing?.sources ||
                    []),
                sourceType,
            ])
        ),
        firstSeenAt:
            existing?.firstSeenAt ||
            Date.now(),
        updatedAt: Date.now(),
        ...existing,
        ...extra,
    };

    if (
        !existing ||
        mapSourcePriority(
            sourceType
        ) >=
        mapSourcePriority(
            existing.sourceType
        )
    ) {
        next.sourceType =
            sourceType;
    }

    next.sources = Array.from(
        new Set([
            ...(existing?.sources ||
                []),
            sourceType,
            ...(extra.sources || []),
        ])
    );

    map.set(uid, next);
}

function normalizeManualMaps(
    raw
) {
    if (!raw) return [];

    if (Array.isArray(raw)) {
        return raw;
    }

    if (Array.isArray(raw.maps)) {
        return raw.maps;
    }

    return [];
}

function loadManualMaps() {
    const manual =
        normalizeManualMaps(
            readJson(
                MANUAL_MAPS_FILE,
                []
            )
        );

    return manual
        .map((item) => {
            if (
                typeof item ===
                "string"
            ) {
                return {
                    mapUid: item,
                    sourceType:
                        "manual_event",
                };
            }

            return {
                mapUid:
                    item.mapUid ||
                    item.uid,
                sourceType:
                    item.sourceType ||
                    item.category ||
                    "manual_event",
                name:
                    item.name ||
                    item.mapName ||
                    null,
                event:
                    item.event ||
                    item.eventName ||
                    null,
                campaign:
                    item.campaign ||
                    null,
                tags: Array.isArray(
                    item.tags
                )
                    ? item.tags
                    : [],
            };
        })
        .filter(
            (item) => item.mapUid
        );
}
function loadWeeklyEventMaps(dir, sourceType) {
    const out = [];

    try {
        if (!fs.existsSync(dir)) {
            return [];
        }

        const files = fs
            .readdirSync(dir)
            .filter((f) => f.endsWith(".json"));

        for (const file of files) {
            try {
                const fullPath = path.join(dir, file);

                const json = readJson(fullPath, null);

                if (!json) continue;

                const maps =
                    json.maps ||
                    json.playlist ||
                    json.mapList ||
                    [];

                const week =
                    json.week ||
                    json.weekNumber ||
                    null;

                for (const map of maps) {
                    const mapUid =
                        map?.mapUid ||
                        map?.uid;

                    if (!mapUid) continue;

                    out.push({
                        mapUid,
                        sourceType,
                        week,
                        eventName:
                            sourceType === "weekly_shorts"
                                ? "Weekly Shorts"
                                : "Weekly Grands",
                        name:
                            map?.name ||
                            map?.mapName ||
                            null,
                    });
                }
            } catch (e) {
                console.error(
                    `Failed parsing ${file}:`,
                    e?.message || e
                );
            }
        }
    } catch (e) {
        console.error(
            "Weekly event loader failed:",
            e?.message || e
        );
    }

    return out;
}

async function fetchTMXPage(page = 1) {
    try {
        const url =
            `https://trackmania.exchange/mapsearch2/search?api=on&mode=1&priord=8&page=${page}`;

        const response =
            await fetchWithTimeout(
                url,
                {
                    headers: {
                        "User-Agent":
                            "trackmaniaevents.com",
                        Accept: "application/json",
                    },
                },
                20000
            );

        if (!response.ok) {
            console.warn(
                `[TMX] Failed page ${page}`
            );


            return [];
        }

        const json =
            await response.json();

        const results =
            Array.isArray(json)
                ? json
                : json?.results || [];

        return results.map((m) => ({
            mapUid:
                m.TrackUID,
            tmxId:
                m.TrackID,
            name:
                m.Name || null,
            author:
                m.Username || null,
            authorTime:
                m.AuthorTime || null,
            uploadedAt:
                m.UploadedAt || null,
            thumbnailUrl:
                m.ThumbnailURL ||
                m.ThumbnailUrl ||
                null,
            tags:
                Array.isArray(m.Tags)
                    ? m.Tags
                    : [],
        }));
    } catch (e) {
        console.error(
            "TMX page fetch failed:",
            e?.message || e
        );

        return [];
    }
}

async function loadTMXUniverse() {
    if (!TMX_ENABLE) {
        return [];
    }

    let cached =
        readJson(
            TMX_CACHE_FILE,
            {
                maps: []
            }
        );

    if (
        cached &&
        Array.isArray(cached.maps)
    ) {
        console.log(
            `[TMX] Loaded cached maps (${cached.maps.length})`
        );
    }

    const maps = [
        ...(cached?.maps || [])
    ];

    const randomStart =
        Math.floor(Math.random() * 50) + 1;

    for (
        let page = randomStart;
        page < randomStart + 3;
        page++
    ) {
        const result =
            await fetchTMXPage(page);

        if (!result.length) {
            console.log(
                `[TMX] Empty page ${page}`
            );

            continue;
        }
        const existing = new Set(
            maps.map((m) => m.mapUid)
        );

        for (const map of result) {
            if (!existing.has(map.mapUid)) {
                maps.push(map);
                existing.add(map.mapUid);
            }
        }

        console.log(
            `[TMX] Loaded page ${page} (${maps.length} maps)`
        );

        await new Promise(
            (resolve) =>
                setTimeout(resolve, 120)
        );
    }

    writeJson(
        TMX_CACHE_FILE,
        {
            builtAt: Date.now(),
            maps,
        }
    );

    return maps;
}

function countMonthsFrom2020July() {
    const start = new Date(
        Date.UTC(2020, 6, 1)
    );

    const now = new Date();

    const end = new Date(
        Date.UTC(
            now.getUTCFullYear(),
            now.getUTCMonth(),
            1
        )
    );

    let count = 0;

    for (
        let d = start;
        d <= end;
        d = new Date(
            Date.UTC(
                d.getUTCFullYear(),
                d.getUTCMonth() + 1,
                1
            )
        )
    ) {
        count++;
    }

    return count;
}

async function getTotdMonthsFromLive(
    accessToken
) {
    const total =
        countMonthsFrom2020July();

    const months = [];

    const batchSize = 24;

    for (
        let offset =
            total - 1;
        offset >= 0;
        offset -= batchSize
    ) {
        const length =
            Math.min(
                batchSize,
                offset + 1
            );

        const url =
            `${LIVE_BASE}/api/token/campaign/month?length=${length}&offset=${offset}`;

        const json =
            await jget(
                url,
                accessToken
            );

        const list =
            json?.monthList || [];

        months.push(...list);

        await new Promise(
            (resolve) =>
                setTimeout(
                    resolve,
                    60
                )
        );
    }

    return months;
}

async function getOfficialCampaigns(
    accessToken
) {
    const url =
        `${LIVE_BASE}/api/campaign/official?offset=0&length=200`;

    const json =
        await jget(
            url,
            accessToken
        );

    return (
        json?.campaignList ||
        []
    );
}

async function getArcadeRooms(
    accessToken
) {
    try {
        const url =
            `${LIVE_BASE}/api/token/club/room?length=100&offset=0`;

        const json =
            await jget(
                url,
                accessToken
            );

        return (
            json?.clubRoomList ||
            json?.roomList ||
            []
        );
    } catch (e) {
        console.error(
            "Arcade room fetch failed:",
            e?.message || e
        );

        return [];
    }
}
async function listAllClubCampaignRefsWithPlaylists(accessToken) {
    const out = [];

    for (
        let offset = 0;
        ;
        offset += CLUB_LIST_BATCH
    ) {
        const url =
            `${LIVE_BASE}/api/token/club/campaign?length=${CLUB_LIST_BATCH}&offset=${offset}`;

        const json =
            await jget(
                url,
                accessToken
            );

        const list =
            json?.clubCampaignList ||
            json?.campaignList ||
            [];

        if (!list.length) {
            break;
        }

        for (const item of list) {
            const clubId =
                item?.clubId ??
                item?.campaign
                    ?.clubId ??
                item?.club?.id;

            const campaignId =
                item?.id ??
                item?.campaignId ??
                item?.campaign?.id;

            const updatedAt =
                new Date(
                    item?.updated ||
                    item?.updatedAt ||
                    0
                ).getTime() || 0;

            const campaignName =
                item?.name ||
                item?.campaign
                    ?.name ||
                item?.campaignName ||
                null;

            const clubName =
                item?.club?.name ||
                item?.clubName ||
                null;

            const playlist = (
                item?.campaign
                    ?.playlist ||
                item?.playlist ||
                []
            )
                .map(
                    (p) =>
                        p?.mapUid
                )
                .filter(Boolean);

            if (
                clubId &&
                campaignId
            ) {
                out.push({
                    clubId,
                    campaignId,
                    updatedAt,
                    playlist,
                    campaignName,
                    clubName,
                });
            }
        }

        if (
            list.length <
            CLUB_LIST_BATCH
        ) {
            break;
        }

        await new Promise(
            (resolve) =>
                setTimeout(
                    resolve,
                    60
                )
        );
    }

    return out
        .sort(
            (a, b) =>
                (b.updatedAt ||
                    0) -
                (a.updatedAt ||
                    0)
        )
        .slice(
            0,
            CLUB_MAX_CAMPAIGNS
        );
}

async function fetchClubCampaignPlaylist(
    accessToken,
    clubId,
    campaignId
) {
    const url =
        `${LIVE_BASE}/api/token/club/${encodeURIComponent(
            clubId
        )}/campaign/${encodeURIComponent(
            campaignId
        )}`;

    try {
        const json =
            await jget(
                url,
                accessToken
            );

        const playlist =
            json?.campaign
                ?.playlist ||
            json?.playlist ||
            [];

        const campaignName =
            json?.campaign
                ?.name ||
            json?.name ||
            null;

        const clubName =
            json?.club?.name ||
            json?.clubName ||
            null;

        return playlist
            .map((p) => ({
                mapUid:
                    p?.mapUid,
                campaignName,
                clubName,
            }))
            .filter(
                (p) =>
                    p.mapUid
            );
    } catch {
        return [];
    }
}

async function fetchMapWR(
    accessToken,
    mapUid
) {
    try {
        const url =
            `${LIVE_BASE}/api/token/leaderboard/group/Personal_Best/map/${encodeURIComponent(
                mapUid
            )}/top`;

        const json =
            await jget(
                url,
                accessToken
            );

        const top =
            json?.tops?.[0]
                ?.top?.[0];

        if (!top) {
            return null;
        }

        const timeMs =
            Number(top.score);

        if (
            !Number.isFinite(timeMs) ||
            timeMs <= 0
        ) {
            return null;
        }

        return {
            mapUid,
            accountId:
                top.accountId,
            timeMs,
            position:
                top.position || 1,
            timestamp:
                normalizeToSeconds(
                    top.timestamp ||
                    Date.now()
                ),
        };
    } catch (e) {
        return null;
    }
}
async function resolveDisplayNames(
    accountIds
) {
    try {
        const ids =
            [...new Set(accountIds)]
                .filter(Boolean)
                .slice(0, 50);

        if (!ids.length) {
            return {};
        }

        const qs =
            ids.map(
                (id) =>
                    `accountId[]=${encodeURIComponent(id)}`
            ).join("&");

        const response =
            await fetch(
                `https://api.trackmania.com/api/display-names?${qs}`,
                {
                    headers: {
                        Authorization:
                            `Bearer ${await getOAuthToken()}`
                    }
                }
            );

        if (!response.ok) {
            return {};
        }

        return await response.json();
    } catch {
        return {};
    }
}

async function computeUniversalMapIndex(
    accessToken,
    {
        includeClub = true,
    } = {}
) {
    const mapMeta =
        new Map();

    // FIXED:
    // removed dead endpoints

    const [
        officialCampaigns,
        totdMonths,
        arcadeRooms,
        tmxMaps,
    ] = await Promise.all([
        getOfficialCampaigns(
            accessToken
        ),
        getTotdMonthsFromLive(
            accessToken
        ),
        getArcadeRooms(
            accessToken
        ),
        loadTMXUniverse(),
    ]);

    for (const campaign of officialCampaigns) {
        const campaignName =
            campaign?.name ||
            campaign?.campaignName ||
            null;

        const seasonUid =
            campaign?.seasonUid ||
            null;

        for (const p of campaign?.playlist ||
            []) {
            if (!p?.mapUid)
                continue;

            addMapMeta(
                mapMeta,
                p.mapUid,
                "official_campaign",
                {
                    campaignName,
                    seasonUid,
                    name:
                        p.name ||
                        p.mapName ||
                        null,
                }
            );
        }
    }

    for (const month of totdMonths) {
        const monthName =
            month?.month ||
            month?.name ||
            null;

        const days =
            Array.isArray(
                month?.days
            )
                ? month.days
                : [];

        for (const day of days) {
            if (
                !day?.mapUid
            )
                continue;

            addMapMeta(
                mapMeta,
                day.mapUid,
                "totd",
                {
                    month:
                        monthName,
                    date:
                        day.date ||
                        day.day ||
                        null,
                    name:
                        day.name ||
                        day.mapName ||
                        null,
                }
            );
        }
    }

    for (const room of arcadeRooms) {
        const maps =
            room?.playlist ||
            room?.mapList ||
            [];

        for (const map of maps) {
            if (
                !map?.mapUid
            )
                continue;

            addMapMeta(
                mapMeta,
                map.mapUid,
                "arcade",
                {
                    roomName:
                        room.name ||
                        null,
                    name:
                        map.name ||
                        map.mapName ||
                        null,
                }
            );
        }
    }
    for (const map of tmxMaps) {
        if (!map?.mapUid)
            continue;

        addMapMeta(
            mapMeta,
            map.mapUid,
            "tmx",
            {
                tmxId:
                    map.tmxId,
                author:
                    map.author,
                authorTime:
                    map.authorTime,
                uploadedAt:
                    map.uploadedAt,
                thumbnailUrl:
                    map.thumbnailUrl,
                tags:
                    map.tags || [],
                name:
                    map.name || null,
            }
        );
    }

    // WEEKLY SHORTS

    const weeklyShortsMaps =
        loadWeeklyEventMaps(
            WEEKLY_SHORTS_DIR,
            "weekly_shorts"
        );

    for (const map of weeklyShortsMaps) {
        addMapMeta(
            mapMeta,
            map.mapUid,
            "weekly_shorts",
            map
        );
    }

    // WEEKLY GRANDS

    const weeklyGrandsMaps =
        loadWeeklyEventMaps(
            WEEKLY_GRANDS_DIR,
            "weekly_grands"
        );

    for (const map of weeklyGrandsMaps) {
        addMapMeta(
            mapMeta,
            map.mapUid,
            "weekly_grands",
            map
        );
    }
    let clubRefs = [];

    if (includeClub) {
        const disk =
            readJson(
                DISK_CLUB,
                null
            );

        const fresh =
            disk &&
            Date.now() -
            (disk.ts || 0) <
            CLUB_UID_TTL &&
            Array.isArray(
                disk.maps
            ) &&
            disk.maps.length;

        if (fresh) {
            for (const item of disk.maps) {
                addMapMeta(
                    mapMeta,
                    item.mapUid,
                    "club_campaign",
                    item
                );
            }
        } else {
            clubRefs =
                await listAllClubCampaignRefsWithPlaylists(
                    accessToken
                );

            const clubMaps =
                [];

            for (const ref of clubRefs) {
                if (
                    ref.playlist
                        ?.length
                ) {
                    for (const uid of ref.playlist) {
                        const item =
                        {
                            mapUid:
                                uid,
                            campaignName:
                                ref.campaignName ||
                                null,
                            clubName:
                                ref.clubName ||
                                null,
                            clubId:
                                ref.clubId,
                            campaignId:
                                ref.campaignId,
                        };

                        clubMaps.push(
                            item
                        );

                        addMapMeta(
                            mapMeta,
                            uid,
                            "club_campaign",
                            item
                        );
                    }
                }
            }
            writeJson(
                DISK_CLUB,
                {
                    ts: Date.now(),
                    maps: clubMaps,
                }
            );
        }
    }

    const manualMaps =
        loadManualMaps();

    for (const item of manualMaps) {
        addMapMeta(
            mapMeta,
            item.mapUid,
            item.sourceType ||
            "manual_event",
            item
        );
    }

    metaCache = {
        allMapUids:
            Array.from(
                mapMeta.keys()
            ),
        officialSet:
            new Set(
                Array.from(
                    mapMeta.entries()
                )
                    .filter(([, v]) =>
                        v.sources.includes(
                            "official_campaign"
                        )
                    )
                    .map(([k]) => k)
            ),
        totdSet:
            new Set(
                Array.from(
                    mapMeta.entries()
                )
                    .filter(([, v]) =>
                        v.sources.includes(
                            "totd"
                        )
                    )
                    .map(([k]) => k)
            ),
        clubSet:
            new Set(
                Array.from(
                    mapMeta.entries()
                )
                    .filter(([, v]) =>
                        v.sources.includes(
                            "club_campaign"
                        )
                    )
                    .map(([k]) => k)
            ),

        shortsSet:
            new Set(
                Array.from(
                    mapMeta.entries()
                )
                    .filter(([, v]) =>
                        v.sources.includes(
                            "weekly_shorts"
                        )
                    )
                    .map(([k]) => k)
            ),

        grandsSet:
            new Set(
                Array.from(
                    mapMeta.entries()
                )
                    .filter(([, v]) =>
                        v.sources.includes(
                            "weekly_grands"
                        )
                    )
                    .map(([k]) => k)
            ),

        tmxSet:
            new Set(
                Array.from(
                    mapMeta.entries()
                )
                    .filter(([, v]) =>
                        v.sources.includes(
                            "tmx"
                        )
                    )
                    .map(([k]) => k)
            ),

        manualSet:
            new Set(
                manualMaps.map(
                    (m) =>
                        m.mapUid
                )
            ),
        mapMeta,
    };

    const mapIndexPayload =
    {
        builtAt:
            Date.now(),
        totalMaps:
            mapMeta.size,
        maps:
            Array.from(
                mapMeta.values()
            ),
    };

    writeJson(
        DISK_MAP_INDEX,
        mapIndexPayload
    );

    if (AUTO_STATIC_WRITE) {
        writeJson(
            path.join(
                METADATA_DIR,
                "map-index.json"
            ),
            mapIndexPayload
        );
    }

    return mapMeta;
}

async function refreshWRCache(
    accessToken
) {
    const rows = [];

    const mapUids =
        metaCache.allMapUids.slice(
            0,
            QUICK_REFRESH_COUNT
        );

    let index = 0;

    async function worker() {
        while (
            index < mapUids.length
        ) {
            const current =
                mapUids[index++];

            try {
                const row =
                    await fetchMapWR(
                        accessToken,
                        current
                    );

                const clean =
                    sanitizeRow(
                        row
                    );

                if (clean) {
                    rows.push(
                        clean
                    );
                }
            } catch { }

            await new Promise(
                (resolve) =>
                    setTimeout(
                        resolve,
                        25
                    )
            );
        }
    }

    await Promise.all(
        Array.from(
            {
                length:
                    WR_CONCURRENCY,
            },
            () => worker()
        )
    );
    const names =
        await resolveDisplayNames(
            rows.map(
                (r) => r.accountId
            )
        );

    for (const row of rows) {
        row.displayName =
            names[row.accountId] ||
            row.accountId;
    }
    wrCache = {
        ts: Date.now(),
        rows,
    };

    writeJson(
        DISK_WR,
        wrCache
    );

    writeJson(
        path.join(
            RECENT_WRS_DIR,
            "latest.json"
        ),
        wrCache
    );

    console.log(
        `[WR] Loaded ${rows.length} WR rows`
    );
}
async function harvestAllWRs(
    accessToken
) {
    const rows =
        [...wrCache.rows];

    const existing =
        new Set(
            rows.map(
                (r) => r.mapUid
            )
        );

    const mapUids =
        metaCache.allMapUids.filter(
            (uid) =>
                !existing.has(uid)
        );

    console.log(
        `[WR] Starting full harvest (${mapUids.length} maps)`
    );

    let index = 0;

    async function worker() {
        while (
            index < mapUids.length
        ) {
            const mapUid =
                mapUids[index++];

            try {
                const row =
                    await fetchMapWR(
                        accessToken,
                        mapUid
                    );

                const clean =
                    sanitizeRow(
                        row
                    );

                if (clean) {
                    rows.push(
                        clean
                    );
                }
            } catch { }

            if (
                rows.length % 100 === 0
            ) {
                wrCache = {
                    ts: Date.now(),
                    rows,
                };

                writeJson(
                    DISK_WR,
                    wrCache
                );

                console.log(
                    `[WR] Harvested ${rows.length}`
                );
            }

            await new Promise(
                (resolve) =>
                    setTimeout(
                        resolve,
                        75
                    )
            );
        }
    }

    await Promise.all(
        Array.from(
            {
                length: 4
            },
            () => worker()
        )
    );

    wrCache = {
        ts: Date.now(),
        rows,
    };

    writeJson(
        DISK_WR,
        wrCache
    );

    console.log(
        `[WR] Full harvest complete (${rows.length})`
    );
}
function inferSourceType(
    uid
) {
    const meta =
        metaCache.mapMeta.get(
            uid
        );

    if (!meta)
        return "unknown";
    if (
        meta?.sources?.includes(
            "weekly_grands"
        )
    )
        return "weekly_grands";

    if (
        meta?.sources?.includes(
            "weekly_shorts"
        )
    )
        return "weekly_shorts";

    if (
        meta?.sources?.includes(
            "tmx"
        )
    )
        return "tmx";
    if (
        meta?.sources?.includes(
            "manual_event"
        )
    )
        return "manual_event";

    if (
        meta?.sources?.includes(
            "official_campaign"
        )
    )
        return "official_campaign";

    if (
        meta?.sources?.includes(
            "totd"
        )
    )
        return "totd";

    if (
        meta?.sources?.includes(
            "club_campaign"
        )
    )
        return "club_campaign";

    if (
        meta?.sources?.includes(
            "arcade"
        )
    )
        return "arcade";

    return "discovered";
}
app.get("/api/ready", async (req, res) => {
    try {
        const counts = {};

        for (const meta of metaCache.mapMeta.values()) {
            for (const source of meta.sources || []) {
                counts[source] = (counts[source] || 0) + 1;
            }
        }

        res.json({
            ok: !building,
            building,
            rows: wrCache.rows.length,
            mapUniverse: metaCache.mapMeta.size,
            fetchedAt: wrCache.ts || null,

            counts,

            breakdown: {
                officialCampaigns:
                    metaCache.officialSet.size,

                totd:
                    metaCache.totdSet.size,

                clubCampaigns:
                    metaCache.clubSet.size,

                weeklyShorts:
                    metaCache.shortsSet.size,

                weeklyGrands:
                    metaCache.grandsSet.size,

                tmx:
                    metaCache.tmxSet.size,

                manual:
                    metaCache.manualSet.size,
            },
        });
    } catch (e) {
        res.status(500).json({
            ok: false,
            error: e?.message || String(e),
        });
    }
});
(async () => {
    try {
        building = true;

        const accessToken =
            await getLiveAccessToken();

        await computeUniversalMapIndex(
            accessToken
        );
        await refreshWRCache(
            accessToken
        );
        harvestAllWRs(
            accessToken
        ).catch(console.error);
        building = false;

        console.log(
            `Loaded ${metaCache.mapMeta.size} maps`
        );
    } catch (e) {
        building = false;

        console.error(
            "Startup build failed:",
            e?.message || e
        );
    }
})();
setInterval(async () => {
    try {
        const accessToken =
            await getLiveAccessToken();

        await computeUniversalMapIndex(
            accessToken
        );
        await refreshWRCache(
            accessToken
        );

        console.log(
            "Map universe refreshed."
        );
    } catch (e) {
        console.error(e);
    }
}, 1000 * 60 * 30);
;
app.get("/api/recent-wrs", (req, res) => {
    const rows =
        [...wrCache.rows]
            .sort(
                (a, b) =>
                    b.timestamp -
                    a.timestamp
            )
            .slice(0, 100);

    sendJsonETag(
        req,
        res,
        {
            ok: true,
            rows,
        }
    );
});
app.get("/api/top-monthly", (req, res) => {
    const limit = Math.max(
        1,
        Number(req.query.limit || 10)
    );

    const leaderboard =
        [...wrCache.rows]
            .sort(
                (a, b) =>
                    a.timeMs -
                    b.timeMs
            )
            .slice(0, limit);

    sendJsonETag(
        req,
        res,
        {
            ok: true,
            leaderboard,
        }
    );
});
app.get("/api/wr-podium", (req, res) => {
    const top =
        [...wrCache.rows]
            .sort(
                (a, b) =>
                    a.timeMs -
                    b.timeMs
            )
            .slice(0, 3);

    sendJsonETag(
        req,
        res,
        {
            ok: true,
            podium: top,
        }
    );
});
app.get("/api/wr-players", (req, res) => {
    const limit = Math.max(
        1,
        Number(req.query.limit || 100)
    );

    const counts = new Map();

    for (const row of wrCache.rows) {
        if (!row?.accountId) continue;

        const existing =
            counts.get(row.accountId) || {
                accountId:
                    row.accountId,
                displayName:
                    row.displayName ||
                    row.accountId,
                wrCount: 0,
                latestTs: 0,
            };

        existing.wrCount++;

        existing.latestTs = Math.max(
            existing.latestTs,
            row.timestamp || 0
        );

        counts.set(
            row.accountId,
            existing
        );
    }

    const players =
        [...counts.values()]
            .sort(
                (a, b) =>
                    b.wrCount -
                    a.wrCount
            )
            .slice(0, limit);

    sendJsonETag(
        req,
        res,
        {
            ok: true,
            players,
            fetchedAt:
                Date.now(),
        }
    );
});
app.get("/api/recent-wrs", (req, res) => {
    const rows =
        [...wrCache.rows]
            .sort(
                (a, b) =>
                    b.timestamp -
                    a.timestamp
            )
            .slice(0, 100);

    sendJsonETag(
        req,
        res,
        {
            ok: true,
            rows,
            fetchedAt:
                Date.now(),
        }
    );
});
app.listen(
    process.env.PORT || 3000,
    () => {
        console.log(
            "Trackmania WR backend running."
        );
    }
);
