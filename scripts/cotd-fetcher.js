// Node 20+ (native fetch). No external deps.
import { writeFile } from "node:fs/promises";

const LIVE  = "https://live-services.trackmania.nadeo.live";
const MEET  = "https://meet.trackmania.nadeo.club";
const OAUTH = "https://api.trackmania.com";

const NADEO_TOKEN      = process.env.NADEO_TOKEN;
const TM_CLIENT_ID     = process.env.TM_CLIENT_ID || "";
const TM_CLIENT_SECRET = process.env.TM_CLIENT_SECRET || "";
const OUTPUT_PATH      = process.env.COTD_OUTPUT || "./cotd.json";

if (!NADEO_TOKEN) {
  console.error("Missing NADEO_TOKEN (add it as a repo secret).");
  process.exit(1);
}

function nadeoHeaders() {
  return { Authorization: `nadeo_v1 t=${NADEO_TOKEN}` };
}

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

async function getTodaysTotdMapUid() {
  const r = await fetch(`${LIVE}/api/token/campaign/month?length=1&offset=0`, {
    headers: nadeoHeaders(),
  });
  if (!r.ok) throw new Error(`month campaign failed: ${r.status}`);
  const data = await r.json();
  const days = data?.monthList?.[0]?.days || [];
  if (!days.length) throw new Error("No TOTD days in month list.");

  const todayUTC = new Date().getUTCDate();
  const entry = days.find(d => d?.day === todayUTC) ?? days.at(-1);
  return entry?.mapUid ?? null;
}

async function getMapInfo(mapUid) {
  const r = await fetch(`${LIVE}/api/token/map/${encodeURIComponent(mapUid)}`, {
    headers: nadeoHeaders(),
  });
  if (!r.ok) throw new Error(`map fetch failed: ${r.status}`);
  const j = await r.json();
  return {
    uid: j.uid,
    name: j.name,
    authorAccountId: j.author,
    thumbnailUrl: j.thumbnailUrl,
  };
}

// Winner of Division 1 in current COTD (if available)
async function getCotdWinnerAccountId() {
  const cur = await fetch(`${MEET}/api/cup-of-the-day/current`, {
    headers: nadeoHeaders(),
  });
  if (cur.status === 204) return null; // no COTD right now
  if (!cur.ok) throw new Error(`COTD current failed: ${cur.status}`);
  const j = await cur.json();

  const compId = j?.competition?.id ?? j?.competition?.liveId;
  if (!compId) return null;

  const roundsRes = await fetch(`${MEET}/api/competitions/${compId}/rounds`, {
    headers: nadeoHeaders(),
  });
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
  if (!matchesRes.ok) throw new Error(`matches failed: ${matchesRes.status}`);
  const matches = await matchesRes.json();
  const match = matches?.matches?.[0];
  if (!match?.id) return null;

  const resultsRes = await fetch(
    `${MEET}/api/matches/${match.id}/results?length=1`,
    { headers: nadeoHeaders() }
  );
  if (!resultsRes.ok) throw new Error(`results failed: ${resultsRes.status}`);
  const results = await resultsRes.json();
  return results?.results?.[0]?.participant ?? null; // accountId
}

async function resolveDisplayNames(accountIds) {
  if (!accountIds?.length) return {};
  const token = await getTmOAuthToken();
  if (!token) return {}; // fall back to IDs if we couldn't get a token

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

function clean(s) { return typeof s === "string" ? s : ""; }

async function main() {
  const mapUid   = await getTodaysTotdMapUid();
  if (!mapUid) throw new Error("Could not determine today's TOTD mapUid");

  const map      = await getMapInfo(mapUid);
  const winnerId = await getCotdWinnerAccountId();

  const toResolve = [map.authorAccountId, ...(winnerId ? [winnerId] : [])];
  const names     = await resolveDisplayNames(toResolve);

  const payload = {
    generatedAt: new Date().toISOString(),
    map: {
      uid: map.uid,
      name: clean(map.name),
      authorAccountId: map.authorAccountId,
      authorDisplayName: names[map.authorAccountId] || map.authorAccountId,
      thumbnailUrl: map.thumbnailUrl,
    },
    cotd: {
      winnerAccountId: winnerId || null,
      winnerDisplayName: (winnerId && names[winnerId]) || winnerId || null,
    },
  };

  await writeFile(OUTPUT_PATH, JSON.stringify(payload, null, 2), "utf8");
  console.log(`Wrote ${OUTPUT_PATH}`);
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
