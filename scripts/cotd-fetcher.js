// Node 20+ (native fetch)
import { mkdir, readFile, writeFile, access } from "node:fs/promises";
import { constants as FS } from "node:fs";
import path from "node:path";

const LIVE  = "https://live-services.trackmania.nadeo.live";
const MEET  = "https://meet.trackmania.nadeo.club";
const OAUTH = "https://api.trackmania.com";

const NADEO_TOKEN      = process.env.NADEO_TOKEN;
const TM_CLIENT_ID     = process.env.TM_CLIENT_ID || "";
const TM_CLIENT_SECRET = process.env.TM_CLIENT_SECRET || "";

const OUTPUT_LATEST    = process.env.COTD_OUTPUT   || "./cotd.json";
const DATA_DIR         = process.env.COTD_DATA_DIR || "./data/cotd";

if (!NADEO_TOKEN) {
  console.error("Missing NADEO_TOKEN (add it as a repo secret).");
  process.exit(1);
}

function nadeoHeaders() {
  return { Authorization: `nadeo_v1 t=${NADEO_TOKEN}` };
}

/* -------------------- OAuth (display names) -------------------- */
async function getTmOAuthToken() {
  if (!TM_CLIENT_ID || !TM_CLIENT_SECRET) return null;
  const body = new URLSearchParams({
    grant_type: "client_credentials",
    client_id: TM_CLIENT_ID,
    client_secret: TM_CLIENT_SECRET,
    scope: "basic display-name"
  });
  const res = await fetch(`${OAUTH}/oauth/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body
  });
  if (!res.ok) {
    console.warn(`TM OAuth token fetch failed: ${res.status}`);
    return null;
  }
  const j = await res.json();
  return j?.access_token || null;
}

async function resolveDisplayNames(accountIds) {
  if (!accountIds?.length) return {};
  const token = await getTmOAuthToken();
  if (!token) return {};
  const qs = accountIds.map(id => `accountId[]=${encodeURIComponent(id)}`).join("&");
  const r = await fetch(`${OAUTH}/api/display-names/account-ids?${qs}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!r.ok) {
    console.warn(`display-names failed: ${r.status} (showing raw IDs)`);
    return {};
  }
  return await r.json(); // { [accountId]: "DisplayName" }
}

/* -------------------- TOTD (resilient) -------------------- */
// Fallback: get current month's TOTD list from trackmania.io (no auth)
async function getTodaysTotdFromTmio() {
  // 0 = current month
  const r = await fetch("https://trackmania.io/api/totd/0", {
    headers: { "User-Agent": "tm-cotd-archiver" }
  });
  if (!r.ok) throw new Error(`tm.io totd failed: ${r.status}`);
  const j = await r.json(); // { days: [ { mapUid, name, author, thumbnail, day, authorPlayer? } ] }
  const todayUTC = new Date().getUTCDate();
  const entry = j?.days?.find(d => d?.day === todayUTC) ?? j?.days?.[j.days.length - 1];
  if (!entry) throw new Error("tm.io totd: no days in response");
  return {
    uid: entry.mapUid,
    name: entry.name,
    authorAccountId: entry?.authorPlayer?.accountId || entry.author || null,
    thumbnailUrl: entry.thumbnail || entry.thumbnailUrl || "",
    from: "tmio",
  };
}

// Preferred: Nadeo Live (needs valid NadeoLiveServices token)
async function getTodaysTotdFromNadeo() {
  const monthRes = await fetch(`${LIVE}/api/token/campaign/month?length=1&offset=0`, {
    headers: nadeoHeaders(),
  });
  if (monthRes.status === 401) throw new Error("NADEO401");
  if (!monthRes.ok) throw new Error(`month campaign failed: ${monthRes.status}`);
  const data = await monthRes.json();
  const days = data?.monthList?.[0]?.days || [];
  if (!days.length) throw new Error("No TOTD days in month list.");
  const todayUTC = new Date().getUTCDate();
  const entry = days.find(d => d?.day === todayUTC) ?? days.at(-1);
  const mapUid = entry?.mapUid;
  if (!mapUid) throw new Error("No mapUid from Live");

  const mapRes = await fetch(`${LIVE}/api/token/map/${encodeURIComponent(mapUid)}`, {
    headers: nadeoHeaders(),
  });
  if (mapRes.status === 401) throw new Error("NADEO401");
  if (!mapRes.ok) throw new Error(`map fetch failed: ${mapRes.status}`);
  const j = await mapRes.json();
  return {
    uid: j.uid,
    name: j.name,
    authorAccountId: j.author,
    thumbnailUrl: j.thumbnailUrl,
    from: "nadeo",
  };
}

// Resilient wrapper
async function getTodaysTotdMapAndInfo() {
  try {
    return await getTodaysTotdFromNadeo();
  } catch (e) {
    console.warn(`[TOTD] Falling back to trackmania.io: ${e?.message || e}`);
    return await getTodaysTotdFromTmio();
  }
}

/* -------------------- COTD Winner (needs Nadeo token) -------------------- */
async function getCotdWinnerAccountId() {
  const cur = await fetch(`${MEET}/api/cup-of-the-day/current`, {
    headers: nadeoHeaders(),
  });
  if (cur.status === 204) return null; // no COTD right now
  if (cur.status === 401) throw new Error("NADEO401");
  if (!cur.ok) throw new Error(`COTD current failed: ${cur.status}`);
  const j = await cur.json();

  const compId = j?.competition?.id ?? j?.competition?.liveId;
  if (!compId) return null;

  const roundsRes = await fetch(`${MEET}/api/competitions/${compId}/rounds`, {
    headers: nadeoHeaders(),
  });
  if (roundsRes.status === 401) throw new Error("NADEO401");
  if (!roundsRes.ok) throw new Error(`rounds failed: ${roundsRes.status}`);
  const rounds = await roundsRes.json();
  if (!Array.isArray(rounds) || !rounds.length) return null;

  const finalRound =
    rounds.find(r => String(r?.name ?? "").toUpperCase().includes("FINAL")) ??
    rounds.reduce((a, b) => ((a?.position ?? 0) > (b?.position ?? 0) ? a : b));

  if (!finalRound?.id) return null;

  const matchesRes = await fetch(
    `${MEET}/api/rounds/${finalRound.id}/matches?length=1&offset=0`,
    { headers: nadeoHeaders() }
  );
  if (matchesRes.status === 401) throw new Error("NADEO401");
  if (!matchesRes.ok) throw new Error(`matches failed: ${matchesRes.status}`);
  const matches = await matchesRes.json();
  const match = matches?.matches?.[0];
  if (!match?.id) return null;

  const resultsRes = await fetch(
    `${MEET}/api/matches/${match.id}/results?length=1`,
    { headers: nadeoHeaders() }
  );
  if (resultsRes.status === 401) throw new Error("NADEO401");
  if (!resultsRes.ok) throw new Error(`results failed: ${resultsRes.status}`);
  const results = await resultsRes.json();
  return results?.results?.[0]?.participant ?? null; // accountId
}

/* -------------------- FS helpers (archive) -------------------- */
function clean(s) { return typeof s === "string" ? s : ""; }
async function ensureDir(p) { await mkdir(p, { recursive: true }); }
async function exists(p) { try { await access(p, FS.F_OK); return true; } catch { return false; } }
async function loadJson(p, fallback) {
  if (!(await exists(p))) return fallback;
  try { return JSON.parse(await readFile(p, "utf8")); }
  catch { return fallback; }
}

async function saveLatest(payload) {
  await writeFile(OUTPUT_LATEST, JSON.stringify(payload, null, 2), "utf8");
  console.log(`Wrote ${OUTPUT_LATEST}`);
}

async function saveMonthlyArchive(payload) {
  const now = new Date();
  const yyyy = now.getUTCFullYear();
  const mm = String(now.getUTCMonth() + 1).padStart(2, "0");
  const dd = String(now.getUTCDate()).padStart(2, "0");
  const monthKey = `${yyyy}-${mm}`;
  const dayKey   = `${yyyy}-${mm}-${dd}`;

  await ensureDir(DATA_DIR);

  // Update month file
  const monthPath = path.join(DATA_DIR, `${monthKey}.json`);
  const monthData = await loadJson(monthPath, { month: monthKey, days: {} });

  monthData.days[dayKey] = {
    date: dayKey,
    map: payload.map,
    cotd: payload.cotd
  };

  await writeFile(monthPath, JSON.stringify(monthData, null, 2), "utf8");
  console.log(`Wrote ${monthPath}`);

  // Update months index
  const indexPath = path.join(DATA_DIR, "months.json");
  const index = await loadJson(indexPath, { months: [] });
  if (!index.months.includes(monthKey)) {
    index.months.push(monthKey);
    index.months.sort().reverse(); // newest first
  }
  await writeFile(indexPath, JSON.stringify(index, null, 2), "utf8");
  console.log(`Wrote ${indexPath}`);
}

/* -------------------- Main -------------------- */
async function main() {
  const map = await getTodaysTotdMapAndInfo();

  // Winner (requires valid Nadeo token). If it fails, set null and continue.
  let winnerId = null;
  try {
    winnerId = await getCotdWinnerAccountId();
  } catch (e) {
    console.warn(`[COTD winner] skipping (need valid Nadeo token): ${e?.message || e}`);
  }

  const toResolve = [map.authorAccountId, ...(winnerId ? [winnerId] : [])].filter(Boolean);
  const names     = await resolveDisplayNames(toResolve);

  const payload = {
    generatedAt: new Date().toISOString(),
    map: {
      uid: map.uid,
      name: clean(map.name),
      authorAccountId: map.authorAccountId || null,
      authorDisplayName: (map.authorAccountId && names[map.authorAccountId]) || map.authorAccountId || "(unknown)",
      thumbnailUrl: map.thumbnailUrl || "",
      source: map.from, // "nadeo" or "tmio"
    },
    cotd: {
      winnerAccountId: winnerId || null,
      winnerDisplayName: (winnerId && names[winnerId]) || winnerId || null,
    },
  };

  await saveLatest(payload);
  await saveMonthlyArchive(payload);
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
