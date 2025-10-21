// scripts/cotd-backfill.js
// Node 20+ (native fetch)
import { mkdir, writeFile, readFile, access, readdir } from "node:fs/promises";
import { constants as FS } from "node:fs";
import path from "node:path";

/* ------------------- env & dirs (same as your fetcher) ------------------- */
const PUBLIC_DIR  = process.env.PUBLIC_DIR || ".";
const COTD_DIR    = `${PUBLIC_DIR}/data/cotd`;

const MEET  = "https://meet.trackmania.nadeo.club";
const CORE  = "https://prod.trackmania.core.nadeo.online";

const NADEO_REFRESH_TOKEN = process.env.NADEO_REFRESH_TOKEN || "";

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
    headers: { "Content-Type": "application/json", Authorization: `nadeo_v1 t=${NADEO_REFRESH_TOKEN}` },
    body: JSON.stringify({ audience: "NadeoLiveServices" })
  });
  if (!r.ok) throw new Error(`refresh failed: ${r.status}`);
  const j = await r.json();
  return j.accessToken;
}
const nadeoHeaders = async () => ({ Authorization: `nadeo_v1 t=${await nadeoAccess()}` });

/* ------------------- meet helpers ------------------- */
/**
 * Search Meet competitions and return those that look like a Cup of the Day
 * that occurred on the given UTC date.
 *
 * NOTE: Meet’s list endpoint isn’t documented publicly. This code uses a generic
 *       competitions list with pagination and filters by name + date.
 *       If your payload fields differ slightly, check logs and tweak the filters.
 */
async function listCompetitions(offset = 0, length = 100) {
  const r = await fetch(`${MEET}/api/competitions?offset=${offset}&length=${length}`, {
    headers: await nadeoHeaders()
  });
  if (!r.ok) throw new Error(`competitions list failed: ${r.status}`);
  const j = await r.json();
  // Expect { competitions: [...], length, offset, total }
  return j;
}

function looksLikeCotd(c) {
  const name = String(c?.name || "").toLowerCase();
  return name.includes("cup of the day") || name.includes("cotd");
}

function sameUTCday(iso, y, m1, d) {
  if (!iso) return false;
  const dt = new Date(iso);
  return (
    dt.getUTCFullYear() === y &&
    dt.getUTCMonth() + 1 === m1 &&
    dt.getUTCDate() === d
  );
}

/** Find the COTD competition that happened on this UTC date. */
async function findCotdCompetitionByDate(y, m1, d) {
  let offset = 0;
  const length = 100;

  while (true) {
    const page = await listCompetitions(offset, length);
    const comps = page?.competitions || page?.items || [];

    // Heuristic: filter to COTD-ish names first
    const candidates = comps.filter(looksLikeCotd);

    // Try matching by day using startDate / startTime / created
    const match =
      candidates.find(c =>
        sameUTCday(c?.startTime || c?.startDate || c?.created || c?.creationTime, y, m1, d)
      ) ||
      // Fallback: some COTDs have the date embedded in the name: YYYY-MM-DD or day number
      candidates.find(c => String(c.name).includes(`${y}-${pad2(m1)}-${pad2(d)}`));

    if (match) return match;

    // Pagination end conditions
    const total = page?.total ?? (offset + comps.length);
    offset += length;
    if (offset >= total || comps.length === 0) return null;
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

/* ------------------- write month ------------------- */
async function upsertMonth(dir, key, dayKey, record) {
  await ensureDir(dir);
  const p = path.join(dir, `${key}.json`);
  const data = await loadJson(p, { month: key, days: {} });
  data.days[dayKey] = record;
  await writeJson(p, data);

  // rebuild months.json
  const items = await readdir(dir, { withFileTypes: true });
  const months = items
    .filter(e => e.isFile() && e.name.endsWith(".json") && e.name !== "months.json")
    .map(e => e.name.replace(/\.json$/,""))
    .sort()
    .reverse();
  await writeJson(path.join(dir, "months.json"), { months });
}

/* ------------------- main backfill ------------------- */
async function backfillMonth(year, month1) {
  const mKey = monthKey(year, month1);
  console.log(`Backfill COTD winners for ${mKey}…`);

  for (const d of daysOfMonth(year, month1)) {
    const dk = dateKey(year, month1, d);

    try {
      const comp = await findCotdCompetitionByDate(year, month1, d);
      if (!comp) {
        console.log(`  ${dk}  no competition found`);
        continue;
      }

      const winnerId = await getD1WinnerForCompetition(comp.id || comp.liveId || comp.uid);
      if (!winnerId) {
        console.log(`  ${dk}  competition=${comp.id || comp.liveId || "?"}  winner: none`);
        continue;
      }

      await upsertMonth(COTD_DIR, mKey, dk, {
        date: dk,
        cotd: { winnerAccountId: winnerId, winnerDisplayName: null } // name resolution optional
      });

      console.log(`  ${dk}  winner=${winnerId}`);
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
    // Default: current month and previous month
    const now = new Date();
    const y = now.getUTCFullYear();
    const m1 = now.getUTCMonth() + 1;
    const prev = new Date(Date.UTC(y, m1 - 2, 1)); // previous month
    await backfillMonth(prev.getUTCFullYear(), prev.getUTCMonth() + 1);
    await backfillMonth(y, m1);
  }
}
main().catch(e => { console.error(e); process.exit(1); });
