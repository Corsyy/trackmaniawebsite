// scripts/cotd-backfill.js
// Node 20+ (native fetch)
import { mkdir, writeFile, readFile, access, readdir } from "node:fs/promises";
import { constants as FS } from "node:fs";
import path from "node:path";

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
  const days = new Date(Date.UTC(year, month1, 0)).getUTCDate();
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

/* ------------------- competitions listing ------------------- */
async function listCompetitions(offset = 0, length = 100) {
  const r = await fetch(`${MEET}/api/competitions?offset=${offset}&length=${length}`, {
    headers: await nadeoHeaders()
  });
  if (!r.ok) throw new Error(`competitions list failed: ${r.status}`);
  return r.json(); // expect { competitions, total, ... } but shape can vary
}

function looksLikeCotd(c) {
  const name = String(c?.name || "").toLowerCase();
  return name.includes("cup of the day") || name.includes("cotd");
}

/**
 * Robust finder: scan up to MAX_PAGES and prefer a strict name match containing YYYY-MM-DD.
 * No “early stop” based on timestamps (they’re fickle across environments).
 */
async function findCotdCompetitionByDate(y, m1, d) {
  const wanted = `${y}-${pad2(m1)}-${pad2(d)}`;
  const MAX_PAGES = 50;
  const PAGE_LEN  = 100;

  for (let page = 0; page < MAX_PAGES; page++) {
    const offset = page * PAGE_LEN;
    const data = await listCompetitions(offset, PAGE_LEN);
    const comps = data?.competitions || data?.items || [];

    if (!Array.isArray(comps) || comps.length === 0) break;

    // First pass: strict name pattern “YYYY-MM-DD”
    let match = comps.find(c => looksLikeCotd(c) && String(c.name).includes(wanted));

    // Second pass: looser name (“cotd” + day number) if strict fails
    if (!match) {
      const dayStr = ` ${d} `; // crude guard against substring noise
      match = comps.find(c => looksLikeCotd(c) && String(c.name).toLowerCase().includes(`cotd`) && String(c.name).includes(dayStr));
    }

    if (match) {
      console.log(`  -> match by name: ${match.name} id: ${match.id || match.liveId || match.uid || "?"}`);
      return match;
    }

    // If API provided a total, stop when we reach the end
    const total = data?.total ?? (offset + comps.length);
    if (offset + comps.length >= total) break;
  }

  return null;
}

/* ------------------- pick D1 winner ------------------- */
async function getD1WinnerForCompetition(compId) {
  if (!compId) return null;

  const roundsRes = await fetch(`${MEET}/api/competitions/${compId}/rounds`, { headers: await nadeoHeaders() });
  if (!roundsRes.ok) throw new Error(`rounds failed: ${roundsRes.status}`);
  const rounds = await roundsRes.json();
  if (!Array.isArray(rounds) || !rounds.length) return null;

  // Prefer a round named “Final”; else highest position
  const finalRound =
    rounds.find(r => String(r?.name ?? "").toLowerCase().includes("final")) ??
    rounds.reduce((a, b) => ((a?.position ?? 0) > (b?.position ?? 0) ? a : b));

  if (!finalRound?.id) return null;

  // Take the first match (there’s usually one)
  const matchesRes = await fetch(`${MEET}/api/rounds/${finalRound.id}/matches?length=50&offset=0`, { headers: await nadeoHeaders() });
  if (!matchesRes.ok) throw new Error(`matches failed: ${matchesRes.status}`);
  const matches = await matchesRes.json();
  const match = matches?.matches?.[0] || matches?.[0];
  if (!match?.id) return null;

  // Pull all results, then choose best by rank/position/points
  const resultsRes = await fetch(`${MEET}/api/matches/${match.id}/results?length=512&offset=0`, { headers: await nadeoHeaders() });
  if (!resultsRes.ok) throw new Error(`results failed: ${resultsRes.status}`);
  const results = await resultsRes.json();

  const arr = results?.results || results || [];
  if (!Array.isArray(arr) || arr.length === 0) return null;

  // Sort: lowest rank first; fallback to position; then highest points
  arr.sort((a, b) => {
    const ar = a.rank ?? a.position ?? Infinity;
    const br = b.rank ?? b.position ?? Infinity;
    if (ar !== br) return ar - br;
    const ap = (typeof a.points === "number" ? -a.points : 0);
    const bp = (typeof b.points === "number" ? -b.points : 0);
    return ap - bp;
  });

  return arr[0]?.participant ?? null;
}

/* ------------------- write month & index ------------------- */
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
  console.log(`[BACKFILL] COTD winners for ${mKey} …`);

  for (const d of daysOfMonth(year, month1)) {
    const dk = dateKey(year, month1, d);
    console.log(`[BACKFILL] find COTD for ${dk}`);

    try {
      const comp = await findCotdCompetitionByDate(year, month1, d);
      if (!comp) {
        console.log(`  ${dk}  no competition found`);
        continue;
      }

      const cid = comp.id || comp.liveId || comp.uid;
      const winnerId = await getD1WinnerForCompetition(cid);
      if (!winnerId) {
        console.log(`  ${dk}  competition=${cid}  winner: none`);
        continue;
      }

      await upsertMonth(COTD_DIR, mKey, dk, {
        date: dk,
        cotd: { winnerAccountId: winnerId, winnerDisplayName: null }
      });

      console.log(`  ${dk}  competition=${cid}  winner=${winnerId}`);
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
    // Default: previous + current month
    const now = new Date();
    const y = now.getUTCFullYear();
    const m1 = now.getUTCMonth() + 1;
    const prev = new Date(Date.UTC(y, m1 - 2, 1));
    await backfillMonth(prev.getUTCFullYear(), prev.getUTCMonth() + 1);
    await backfillMonth(y, m1);
  }
}
main().catch(e => { console.error(e); process.exit(1); });
