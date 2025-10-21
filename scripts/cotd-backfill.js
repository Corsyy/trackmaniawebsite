// scripts/cotd-backfill.js
// Node 20+ (native fetch)
import { mkdir, writeFile, readFile, access, readdir } from "node:fs/promises";
import { constants as FS } from "node:fs";
import path from "node:path";

/* ------------------- env & dirs ------------------- */
const PUBLIC_DIR  = process.env.PUBLIC_DIR || ".";
const COTD_DIR    = `${PUBLIC_DIR}/data/cotd`;

const MEET  = "https://meet.trackmania.nadeo.club";
const CORE  = "https://prod.trackmania.core.nadeo.online";
const OAUTH = "https://api.trackmania.com";

const NADEO_REFRESH_TOKEN = process.env.NADEO_REFRESH_TOKEN || "";
const TM_CLIENT_ID        = process.env.TM_CLIENT_ID || "";
const TM_CLIENT_SECRET    = process.env.TM_CLIENT_SECRET || "";

/* ------------------- fs helpers ------------------- */
const ensureDir = (p) => mkdir(p, { recursive: true });
const exists    = async (p) => { try { await access(p, FS.F_OK); return true; } catch { return false; } };
const loadJson  = async (p, f) => (await exists(p)) ? JSON.parse(await readFile(p, "utf8")) : f;
const writeJson = (p, obj) => writeFile(p, JSON.stringify(obj, null, 2), "utf8");

/* ------------------- date helpers ------------------- */
const pad2 = (n) => String(n).padStart(2, "0");
const monthKey = (y, m1) => `${y}-${pad2(m1)}`;
const dateKey  = (y, m1, d) => `${y}-${pad2(m1)}-${pad2(d)}`;

function* daysOfMonth(year, month1) {
  const days = new Date(Date.UTC(year, month1, 0)).getUTCDate(); // month1 is 1-based
  for (let d = 1; d <= days; d++) yield d;
}

/* ------------------- auth ------------------- */
async function nadeoAccess() {
  if (!NADEO_REFRESH_TOKEN) throw new Error("Missing NADEO_REFRESH_TOKEN");
  const r = await fetch(`${CORE}/v2/authentication/token/refresh`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `nadeo_v1 t=${NADEO_REFRESH_TOKEN}`
    },
    body: JSON.stringify({ audience: "NadeoLiveServices" })
  });
  if (!r.ok) throw new Error(`refresh failed: ${r.status}`);
  const j = await r.json();
  return j.accessToken;
}
const nadeoHeaders = async () => ({ Authorization: `nadeo_v1 t=${await nadeoAccess()}` });

/* ----- optional: resolve display names via TM OAuth (best-effort) ----- */
async function tmOAuth() {
  if (!TM_CLIENT_ID || !TM_CLIENT_SECRET) return null;
  const body = new URLSearchParams({
    grant_type: "client_credentials",
    client_id: TM_CLIENT_ID,
    client_secret: TM_CLIENT_SECRET,
    scope: "basic display-name"
  });
  const r = await fetch(`${OAUTH}/oauth/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body
  });
  if (!r.ok) return null;
  const j = await r.json();
  return j.access_token;
}
async function resolveNames(ids) {
  if (!ids?.length) return {};
  const token = await tmOAuth();
  if (!token) return {};
  const qs = ids.map(i => `accountId[]=${encodeURIComponent(i)}`).join("&");
  const r = await fetch(`${OAUTH}/api/display-names/account-ids?${qs}`, {
    headers: { Authorization: `Bearer ${token}` }
  });
  if (!r.ok) return {};
  return r.json();
}

/* ------------------- meet helpers ------------------- */
function looksLikeCotd(c) {
  const name = String(c?.name || "").toLowerCase();
  return name.includes("cup of the day") || name.includes("cotd");
}

// pull competitions array regardless of shape
function competitionsFromPage(page) {
  if (Array.isArray(page)) return page;
  if (Array.isArray(page?.competitions)) return page.competitions;
  if (Array.isArray(page?.items)) return page.items;
  return [];
}

// 18h tolerance to handle UTC midnight drift
const TOL_MS = 18 * 60 * 60 * 1000;
function isWithinUTCWindow(iso, y, m1, d, tolMs = TOL_MS) {
  if (!iso) return false;
  const t = new Date(iso).getTime();
  const dayStart = Date.UTC(y, m1 - 1, d, 0, 0, 0);
  const delta = Math.abs(t - dayStart);
  return delta <= tolMs;
}

async function listCompetitions(offset = 0, length = 100) {
  const url = `${MEET}/api/competitions?offset=${offset}&length=${length}`;
  const r = await fetch(url, { headers: await nadeoHeaders() });
  if (!r.ok) {
    console.log("[BACKFILL] listCompetitions", url, "->", r.status);
    throw new Error(`competitions list failed: ${r.status}`);
  }
  const j = await r.json();
  return j;
}

/** Find the COTD competition that happened on this UTC date (y,m1,d). */
async function findCotdCompetitionByDate(y, m1, d) {
  let offset = 0;
  const length = 100;
  const targetYYYYMMDD = `${y}-${pad2(m1)}-${pad2(d)}`;
  console.log(`[BACKFILL] find COTD for ${targetYYYYMMDD}`);

  while (true) {
    const page = await listCompetitions(offset, length);
    const comps = competitionsFromPage(page);
    if (!comps.length) {
      console.log("[BACKFILL] empty page, stop");
      return null;
    }

    const candidates = comps.filter(looksLikeCotd);
    const fields = ["startTime","startDate","created","creationTime","updated","updateTime"];

    for (const c of candidates) {
      const name = c?.name || "(no name)";
      const id = c?.id || c?.liveId || c?.uid || "?";
      // try all known date fields with tolerance
      for (const f of fields) {
        if (isWithinUTCWindow(c?.[f], y, m1, d)) {
          console.log(`  -> match by ${f}:`, name, "id:", id, "at", c?.[f]);
          return c;
        }
      }
      // fallback: embedded date in name
      if (String(name).includes(targetYYYYMMDD)) {
        console.log(`  -> match by name:`, name, "id:", id);
        return c;
      }
    }

    // pagination/stop conditions
    const total = page?.total ?? (offset + comps.length + 1);
    offset += length;

    // If the oldest item on the page is far older than the target, stop scanning
    const times = comps
      .map(c => new Date(c?.startTime || c?.startDate || c?.created || c?.creationTime || 0).getTime())
      .filter(Number.isFinite)
      .sort((a,b) => a - b);

    if (times.length) {
      const oldest = times[0];
      const target = Date.UTC(y, m1 - 1, d);
      if (target - oldest > 5 * 86400000) {
        console.log("[BACKFILL] paged past target window, stop");
        return null;
      }
    }

    if (offset >= total) {
      console.log("[BACKFILL] reached end (offset >= total), stop");
      return null;
    }
  }
}

/** Given a competition id, return the D1 winner account id (if any). */
async function getD1WinnerForCompetition(compId) {
  if (!compId) return null;

  const roundsRes = await fetch(`${MEET}/api/competitions/${compId}/rounds`, { headers: await nadeoHeaders() });
  if (!roundsRes.ok) throw new Error(`rounds failed: ${roundsRes.status}`);
  const rounds = await roundsRes.json();
  if (!Array.isArray(rounds) || !rounds.length) return null;

  const finalRound =
    rounds.find(r => String(r?.name ?? "").toUpperCase().includes("FINAL")) ??
    rounds.reduce((a, b) => ((a?.position ?? 0) > (b?.position ?? 0) ? a : b));

  if (!finalRound?.id) return null;

  const matchesRes = await fetch(`${MEET}/api/rounds/${finalRound.id}/matches?length=1&offset=0`, { headers: await nadeoHeaders() });
  if (!matchesRes.ok) throw new Error(`matches failed: ${matchesRes.status}`);
  const matches = await matchesRes.json();
  const match = matches?.matches?.[0];
  if (!match?.id) return null;

  const resultsRes = await fetch(`${MEET}/api/matches/${match.id}/results?length=1`, { headers: await nadeoHeaders() });
  if (!resultsRes.ok) throw new Error(`results failed: ${resultsRes.status}`);
  const results = await resultsRes.json();
  return results?.results?.[0]?.participant ?? null;
}

/* ------------------- write month & index ------------------- */
async function rebuildMonthIndex(dir) {
  await ensureDir(dir);
  const items = await readdir(dir, { withFileTypes: true });
  const months = items
    .filter(e => e.isFile() && e.name.endsWith(".json") && e.name !== "months.json")
    .map(e => e.name.replace(/\.json$/,""))
    .sort()
    .reverse();
  await writeJson(path.join(dir, "months.json"), { months });
}

async function upsertMonth(dir, key, dayKey, record) {
  await ensureDir(dir);
  const p = path.join(dir, `${key}.json`);
  const data = await loadJson(p, { month: key, days: {} });
  data.days[dayKey] = record;
  await writeJson(p, data);
  await rebuildMonthIndex(dir);
}

/* ------------------- backfill main ------------------- */
async function backfillMonth(year, month1) {
  const mKey = monthKey(year, month1);
  console.log(`\n[BACKFILL] COTD winners for ${mKey} …`);

  for (const d of daysOfMonth(year, month1)) {
    const dk = dateKey(year, month1, d);
    try {
      const comp = await findCotdCompetitionByDate(year, month1, d);
      if (!comp) {
        console.log(`  ${dk}  no competition found`);
        continue;
      }

      const compId = comp.id || comp.liveId || comp.uid;
      const winnerId = await getD1WinnerForCompetition(compId);
      if (!winnerId) {
        console.log(`  ${dk}  competition=${compId}  winner: none`);
        continue;
      }

      // Optional: resolve display name (best effort)
      let winnerDisplayName = null;
      try {
        const names = await resolveNames([winnerId]);
        winnerDisplayName = names?.[winnerId] || null;
      } catch { /* ignore */ }

      await upsertMonth(COTD_DIR, mKey, dk, {
        date: dk,
        cotd: { winnerAccountId: winnerId, winnerDisplayName }
      });

      console.log(`  ${dk}  winner=${winnerDisplayName || winnerId}  (wrote -> ${mKey}.json)`);
    } catch (e) {
      console.log(`  ${dk}  error: ${e.message}`);
    }
  }
}

/* ------------------- CLI ------------------- */
async function main() {
  const args = process.argv.slice(2).map(x => x.trim());
  if (args.length === 2) {
    const year = parseInt(args[0], 10);
    const month1 = parseInt(args[1], 10);
    if (!year || !month1) throw new Error("Usage: node scripts/cotd-backfill.js YYYY MM");
    await backfillMonth(year, month1);
  } else {
    // Default: previous month + current month
    const now = new Date();
    const y = now.getUTCFullYear();
    const m1 = now.getUTCMonth() + 1;
    const prev = new Date(Date.UTC(y, m1 - 2, 1));
    await backfillMonth(prev.getUTCFullYear(), prev.getUTCMonth() + 1);
    await backfillMonth(y, m1);
  }
}
main().catch(e => { console.error(e); process.exit(1); });
