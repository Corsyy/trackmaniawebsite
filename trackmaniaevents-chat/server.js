// server.js (ESM)
import express from "express";
import crypto from "crypto";
import path from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();

const PORT = process.env.PORT || 3000;
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || "";
const AUTH_SECRET = process.env.AUTH_SECRET || "";
const OPENAI_API_KEY = process.env.OPENAI_API_KEY || "";

const SITE_BASE = process.env.SITE_BASE || "https://trackmaniaevents.com";
const SITEMAP_URL = process.env.SITEMAP_URL || `${SITE_BASE.replace(/\/+$/,"")}/sitemap.xml`;
const AI_MODEL = process.env.AI_MODEL || "gpt-4.1-mini";

if (!ADMIN_PASSWORD) console.warn("[WARN] ADMIN_PASSWORD is not set");
if (!AUTH_SECRET) console.warn("[WARN] AUTH_SECRET is not set");
if (!OPENAI_API_KEY) console.warn("[WARN] OPENAI_API_KEY is not set (AI auto-replies disabled)");

// ===========================
// In-memory store
// ===========================
/**
 * Map<sid, {
 *   sid: string,
 *   status: "open"|"closed",
 *   createdAt: number,
 *   updatedAt: number,
 *   assignedTo: "ai"|"admin",
 *   needsAdmin: boolean,
 *   visitorEmail: string|null,
 *   messages: Array<{ from:"visitor"|"admin"|"system"|"ai", text:string, ts:number }>
 * }>
 */
const conversations = new Map();

// Operators online flag (admin controlled)
let operatorsOnline = true;

// ===========================
// Middleware
// ===========================
app.disable("x-powered-by");
app.use(express.json({ limit: "256kb" }));

// Serve admin UI
app.use("/admin", express.static(path.join(__dirname, "admin"), { extensions: ["html"] }));

// ===========================
// CORS (public widget endpoints only)
// ===========================
const ALLOWED_ORIGINS = new Set([
  "https://trackmaniaevents.com",
  "https://www.trackmaniaevents.com",
  "https://trackmaniaevents-chat.onrender.com",
]);

function applyChatCors(req, res) {
  const origin = req.headers.origin;
  if (origin && ALLOWED_ORIGINS.has(origin)) {
    res.setHeader("Access-Control-Allow-Origin", origin);
    res.setHeader("Vary", "Origin");
  }
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  res.setHeader("Access-Control-Max-Age", "86400");
}

app.options("/api/chat/*", (req, res) => {
  applyChatCors(req, res);
  return res.sendStatus(204);
});

app.use("/api/chat", (req, res, next) => {
  applyChatCors(req, res);
  next();
});

// ===========================
// Utilities
// ===========================
function now() { return Date.now(); }
function newSid() { return crypto.randomBytes(16).toString("hex"); }
function safeText(input) {
  const t = String(input ?? "").trim();
  return t.length > 2000 ? t.slice(0, 2000) : t;
}
function sleep(ms){ return new Promise(r=>setTimeout(r,ms)); }

// ===========================
// Cookie helpers (NO cookie-parser)
// ===========================
function getCookie(req, name) {
  const header = req.headers.cookie || "";
  const parts = header.split(";").map(p => p.trim());
  for (const p of parts) {
    if (p.startsWith(name + "=")) return decodeURIComponent(p.slice(name.length + 1));
  }
  return null;
}

// ===========================
// Admin auth
// ===========================
const ADMIN_COOKIE_NAME = "tme_admin";

function signToken(payload) {
  const sig = crypto.createHmac("sha256", AUTH_SECRET).update(payload).digest("hex");
  return `${payload}.${sig}`;
}

function verifyToken(token) {
  if (!token) return null;
  const i = token.lastIndexOf(".");
  if (i < 0) return null;
  const payload = token.slice(0, i);
  const sig = token.slice(i + 1);
  const expected = crypto.createHmac("sha256", AUTH_SECRET).update(payload).digest("hex");
  try {
    if (!crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected))) return null;
  } catch {
    return null;
  }
  return payload;
}

function requireAdmin(req, res, next) {
  if (!AUTH_SECRET) return res.status(500).json({ ok:false, error:"AUTH_SECRET not configured" });
  const token = getCookie(req, ADMIN_COOKIE_NAME);
  const payload = verifyToken(token);
  if (!payload || !payload.startsWith("v1:")) {
    return res.status(401).json({ ok:false, error:"Unauthorized" });
  }
  next();
}

// ===========================
// Knowledge Base (Sitemap ingestion)
// ===========================
/**
 * kbChunks: Array<{ id:string, url:string, title:string, text:string }>
 */
let kbChunks = [];
let kbStatus = { lastRefreshAt: 0, pageCount: 0, chunkCount: 0, lastError: "" };

const KB_MAX_PAGES = 200;
const KB_CHUNK_SIZE = 1000;
const KB_CHUNK_OVERLAP = 180;

function stripHtml(html) {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, " ")
    .replace(/<nav[\s\S]*?<\/nav>/gi, " ")
    .replace(/<footer[\s\S]*?<\/footer>/gi, " ")
    .replace(/<\/?[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function extractTitle(html) {
  const m = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  return m ? m[1].replace(/\s+/g," ").trim().slice(0,120) : "";
}

function chunkText(text) {
  const out = [];
  let i = 0;
  while (i < text.length) {
    const slice = text.slice(i, i + KB_CHUNK_SIZE);
    out.push(slice);
    i += (KB_CHUNK_SIZE - KB_CHUNK_OVERLAP);
  }
  return out;
}

async function fetchText(url) {
  const r = await fetch(url, { redirect: "follow" });
  if (!r.ok) throw new Error(`Fetch failed ${r.status} for ${url}`);
  return await r.text();
}

function parseSitemapLocs(xml) {
  const locs = [];
  const re = /<loc>\s*([^<\s]+)\s*<\/loc>/gi;
  let m;
  while ((m = re.exec(xml))) {
    try {
      const u = new URL(m[1]);
      // Only crawl SITE_BASE host
      const base = new URL(SITE_BASE);
      if (u.host === base.host) locs.push(u.toString());
    } catch {}
  }
  // de-dupe
  return [...new Set(locs)];
}

async function refreshKnowledge() {
  kbStatus.lastError = "";
  const started = now();
  const xml = await fetchText(SITEMAP_URL);
  const urls = parseSitemapLocs(xml).slice(0, KB_MAX_PAGES);

  const newChunks = [];
  let pageCount = 0;

  for (const url of urls) {
    try {
      const html = await fetchText(url);
      const title = extractTitle(html);
      const text = stripHtml(html);

      // Skip pages that are basically empty
      if (text.length < 200) continue;

      const chunks = chunkText(text);
      for (let idx = 0; idx < chunks.length; idx++) {
        newChunks.push({
          id: `${crypto.createHash("sha1").update(url + ":" + idx).digest("hex")}`,
          url,
          title,
          text: chunks[idx],
        });
      }
      pageCount++;
      // small politeness delay
      await sleep(60);
    } catch (e) {
      // keep going; record last error
      kbStatus.lastError = String(e?.message || e);
    }
  }

  kbChunks = newChunks;
  kbStatus = {
    lastRefreshAt: started,
    pageCount,
    chunkCount: kbChunks.length,
    lastError: kbStatus.lastError || "",
  };
}

function tokenize(s) {
  return String(s||"")
    .toLowerCase()
    .replace(/https?:\/\/\S+/g," ")
    .replace(/[^a-z0-9\s]/g," ")
    .split(/\s+/)
    .filter(w => w.length >= 3)
    .slice(0, 30);
}

function searchKB(query, k = 6) {
  if (!kbChunks.length) return [];
  const q = tokenize(query);
  if (!q.length) return [];
  const scores = [];

  for (const c of kbChunks) {
    let score = 0;
    const hay = (c.title + " " + c.text).toLowerCase();
    for (const w of q) {
      const n = hay.split(w).length - 1;
      if (n > 0) score += Math.min(4, n);
    }
    if (score > 0) scores.push({ c, score });
  }

  scores.sort((a,b)=>b.score-a.score);
  return scores.slice(0, k).map(x => x.c);
}

// ===========================
// AI helpers
// ===========================
const EMAIL_RE = /([a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,})/i;

function shouldEscalateHeuristics(text) {
  const t = String(text||"").toLowerCase();
  if (t.includes("human") || t.includes("operator") || t.includes("admin") || t.includes("real person")) return true;
  if (t.includes("payment") || t.includes("billing") || t.includes("credit card")) return true;
  if (t.includes("password") || t.includes("token") || t.includes("api key")) return true;
  return false;
}

async function callOpenAI({ question, contextChunks, convo }) {
  // If no key, behave as "unsure"
  if (!OPENAI_API_KEY) {
    return { reply: "", escalate: true, confidence: 0.0, reason: "no_api_key" };
  }

  const context = contextChunks.map((c, i) => {
    const title = c.title ? `Title: ${c.title}\n` : "";
    return `[#${i+1}] ${title}URL: ${c.url}\n${c.text}`;
  }).join("\n\n");

  const recent = convo.messages
    .slice(-12)
    .map(m => `${m.from.toUpperCase()}: ${m.text}`)
    .join("\n");

  const system = `
You are the Trackmania Events site assistant for trackmaniaevents.com.
You must answer using ONLY the provided CONTEXT snippets. If the answer is not clearly in context, you must escalate.
Return STRICT JSON with keys: reply (string), escalate (boolean), confidence (0-1 number).
If escalating, reply should be either:
- "Transferring you to an operator right now."
- "There are no operators online at the moment. Leave your email address and we’ll reply as soon as possible, or come back later."
Pick based on the operatorsOnline flag provided.
Keep replies concise and helpful. If you include links, only use URLs from CONTEXT.
`.trim();

  const user = `
operatorsOnline: ${operatorsOnline ? "true" : "false"}

CONTEXT:
${context || "[no context]"}

CHAT:
${recent}

QUESTION:
${question}
`.trim();

  const body = {
    model: AI_MODEL,
    input: [
      { role: "system", content: system },
      { role: "user", content: user },
    ],
  };

  const r = await fetch("https://api.openai.com/v1/responses", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${OPENAI_API_KEY}`,
    },
    body: JSON.stringify(body),
  });

  if (!r.ok) {
    const txt = await r.text().catch(()=> "");
    return { reply: "", escalate: true, confidence: 0.0, reason: `openai_${r.status}:${txt.slice(0,200)}` };
  }

  const data = await r.json();

  // Responses API returns output in different shapes; safest: pull all text parts.
  let text = "";
  try {
    const parts = data.output?.flatMap(o => o.content || []) || [];
    text = parts.map(p => p.text || "").join("").trim();
  } catch {}

  // Fallback: if nothing found
  if (!text) return { reply: "", escalate: true, confidence: 0.0, reason: "empty_response" };

  // Parse JSON response
  try {
    const jsonStart = text.indexOf("{");
    const jsonEnd = text.lastIndexOf("}");
    const raw = (jsonStart >= 0 && jsonEnd > jsonStart) ? text.slice(jsonStart, jsonEnd + 1) : text;
    const parsed = JSON.parse(raw);

    const reply = String(parsed.reply ?? "").trim();
    const escalate = Boolean(parsed.escalate);
    const confidence = Math.max(0, Math.min(1, Number(parsed.confidence ?? 0)));

    return { reply, escalate, confidence };
  } catch {
    // If the model fails format, escalate.
    return { reply: "", escalate: true, confidence: 0.0, reason: "bad_json" };
  }
}

function pushSystem(convo, text) {
  const ts = now();
  convo.messages.push({ from: "system", text, ts });
  convo.updatedAt = ts;
}

function pushAI(convo, text) {
  const ts = now();
  convo.messages.push({ from: "ai", text, ts });
  convo.updatedAt = ts;
}

function escalate(convo) {
  convo.assignedTo = "admin";
  convo.needsAdmin = true;
}

// ===========================
// Helpers
// ===========================
function convoSummary(c) {
  const last = c.messages[c.messages.length - 1];
  return {
    sid: c.sid,
    status: c.status,
    assignedTo: c.assignedTo,
    needsAdmin: c.needsAdmin,
    visitorEmail: c.visitorEmail,
    createdAt: c.createdAt,
    updatedAt: c.updatedAt,
    lastMessageAt: last?.ts ?? c.updatedAt,
    lastFrom: last?.from ?? null,
    lastTextPreview: last?.text ? String(last.text).slice(0, 80) : "",
    messageCount: c.messages.length,
  };
}

function getConvoOr404(sid, res) {
  const c = conversations.get(sid);
  if (!c) {
    res.status(404).json({ ok: false, error: "Conversation not found", status: "missing" });
    return null;
  }
  return c;
}

// ===========================
// Public Chat API
// ===========================
app.post("/api/chat/init", (req, res) => {
  const sid = newSid();
  const ts = now();
  const convo = {
    sid,
    status: "open",
    createdAt: ts,
    updatedAt: ts,
    assignedTo: "ai",
    needsAdmin: false,
    visitorEmail: null,
    messages: [{ from: "system", text: "Chat started.", ts }],
  };
  conversations.set(sid, convo);
  res.json({ ok: true, sid, status: convo.status });
});

app.get("/api/chat/poll", (req, res) => {
  const sid = String(req.query.sid || "").trim();
  const since = Number(req.query.since || 0);

  if (!sid) return res.status(400).json({ ok: false, error: "Missing sid" });

  const convo = conversations.get(sid);
  if (!convo) {
    return res.status(404).json({ ok: false, error: "Conversation not found", status: "missing" });
  }

  const msgs = since > 0 ? convo.messages.filter(m => m.ts > since) : convo.messages;

  res.json({
    ok: true,
    sid: convo.sid,
    status: convo.status,
    assignedTo: convo.assignedTo,
    needsAdmin: convo.needsAdmin,
    serverTime: now(),
    messages: msgs,
  });
});

app.post("/api/chat/send", (req, res) => {
  const sid = safeText(req.body?.sid);
  const text = safeText(req.body?.text);

  if (!sid) return res.status(400).json({ ok: false, error: "Missing sid" });
  if (!text) return res.status(400).json({ ok: false, error: "Missing text" });

  const convo = conversations.get(sid);
  if (!convo) return res.status(404).json({ ok: false, error: "Conversation not found", status: "missing" });

  if (convo.status === "closed") {
    return res.status(409).json({ ok: false, error: "Chat is closed", status: "closed" });
  }

  // capture email only after escalation prompt
  if (convo.needsAdmin && !convo.visitorEmail) {
    const m = text.match(EMAIL_RE);
    if (m) {
      convo.visitorEmail = m[1];
      pushSystem(convo, `[Visitor email captured: ${convo.visitorEmail}]`);
    }
  }

  const ts = now();
  convo.messages.push({ from: "visitor", text, ts });
  convo.updatedAt = ts;

  res.json({ ok: true, sid: convo.sid, status: convo.status, serverTime: ts });

  // ---- AI auto-reply (fire-and-forget) ----
  if (convo.assignedTo !== "ai" || convo.needsAdmin) return;

  (async () => {
    try {
      // quick heuristic escalation (human request, sensitive topics)
      if (shouldEscalateHeuristics(text)) {
        const msg = operatorsOnline
          ? "Transferring you to an operator right now."
          : "There are no operators online at the moment. Leave your email address and we’ll reply as soon as possible, or come back later.";
        pushAI(convo, msg);
        escalate(convo);
        return;
      }

      const hits = searchKB(text, 6);

      // If we don't have KB loaded or no matches, escalate
      if (!kbChunks.length || hits.length === 0) {
        const msg = operatorsOnline
          ? "Transferring you to an operator right now."
          : "There are no operators online at the moment. Leave your email address and we’ll reply as soon as possible, or come back later.";
        pushAI(convo, msg);
        escalate(convo);
        return;
      }

      const result = await callOpenAI({ question: text, contextChunks: hits, convo });

      // decide escalation based on model output / confidence
      const mustEscalate = result.escalate || result.confidence < 0.55;

      if (mustEscalate) {
        const msg = operatorsOnline
          ? "Transferring you to an operator right now."
          : "There are no operators online at the moment. Leave your email address and we’ll reply as soon as possible, or come back later.";
        pushAI(convo, msg);
        escalate(convo);
        return;
      }

      // good answer
      if (result.reply) {
        pushAI(convo, result.reply);
      } else {
        // if empty, escalate
        const msg = operatorsOnline
          ? "Transferring you to an operator right now."
          : "There are no operators online at the moment. Leave your email address and we’ll reply as soon as possible, or come back later.";
        pushAI(convo, msg);
        escalate(convo);
      }
    } catch (e) {
      // on any failure, escalate
      const msg = operatorsOnline
        ? "Transferring you to an operator right now."
        : "There are no operators online at the moment. Leave your email address and we’ll reply as soon as possible, or come back later.";
      pushAI(convo, msg);
      escalate(convo);
    }
  })();
});

// ===========================
// Admin API
// ===========================
app.post("/api/admin/login", (req, res) => {
  if (!AUTH_SECRET) return res.status(500).json({ ok: false, error: "AUTH_SECRET not configured" });

  const password = safeText(req.body?.password);
  if (!password) return res.status(400).json({ ok: false, error: "Missing password" });

  if (!ADMIN_PASSWORD || password !== ADMIN_PASSWORD) {
    return res.status(401).json({ ok: false, error: "Invalid password" });
  }

  const payload = `v1:${now()}:${crypto.randomBytes(8).toString("hex")}`;
  const token = signToken(payload);

  res.setHeader(
    "Set-Cookie",
    `${ADMIN_COOKIE_NAME}=${encodeURIComponent(token)}; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=${60 * 60 * 24 * 7}`
  );

  res.json({ ok: true });
});

app.post("/api/admin/logout", requireAdmin, (req, res) => {
  res.setHeader("Set-Cookie", `${ADMIN_COOKIE_NAME}=; Max-Age=0; Path=/`);
  res.json({ ok: true });
});

app.get("/api/admin/conversations", requireAdmin, (req, res) => {
  const list = [...conversations.values()]
    .sort((a, b) => b.updatedAt - a.updatedAt)
    .map(convoSummary);

  res.json({ ok: true, conversations: list, operatorsOnline, kbStatus });
});

app.get("/api/admin/conversation", requireAdmin, (req, res) => {
  const sid = String(req.query.sid || "").trim();
  if (!sid) return res.status(400).json({ ok: false, error: "Missing sid" });

  const convo = getConvoOr404(sid, res);
  if (!convo) return;

  res.json({
    ok: true,
    sid: convo.sid,
    status: convo.status,
    assignedTo: convo.assignedTo,
    needsAdmin: convo.needsAdmin,
    visitorEmail: convo.visitorEmail,
    createdAt: convo.createdAt,
    updatedAt: convo.updatedAt,
    messages: convo.messages,
  });
});

app.post("/api/admin/send", requireAdmin, (req, res) => {
  const sid = safeText(req.body?.sid);
  const text = safeText(req.body?.text);

  if (!sid) return res.status(400).json({ ok: false, error: "Missing sid" });
  if (!text) return res.status(400).json({ ok: false, error: "Missing text" });

  const convo = getConvoOr404(sid, res);
  if (!convo) return;

  if (convo.status === "closed") {
    return res.status(409).json({ ok: false, error: "Chat is closed", status: "closed" });
  }

  const ts = now();
  convo.messages.push({ from: "admin", text, ts });
  convo.updatedAt = ts;

  // If admin replies, keep assignedTo admin
  convo.assignedTo = "admin";
  convo.needsAdmin = false;

  res.json({ ok: true, sid: convo.sid, status: convo.status, serverTime: ts });
});

app.post("/api/admin/close", requireAdmin, (req, res) => {
  const sid = safeText(req.body?.sid);
  if (!sid) return res.status(400).json({ ok: false, error: "Missing sid" });

  const convo = getConvoOr404(sid, res);
  if (!convo) return;

  if (convo.status === "closed") {
    return res.json({ ok: true, sid: convo.sid, status: convo.status, serverTime: now() });
  }

  const ts = now();
  convo.status = "closed";
  convo.messages.push({ from: "system", text: "[Chat ended by admin]", ts });
  convo.updatedAt = ts;

  res.json({ ok: true, sid: convo.sid, status: convo.status, serverTime: ts });
});

// Operators toggle
app.get("/api/admin/operators", requireAdmin, (req, res) => {
  res.json({ ok: true, operatorsOnline });
});

app.post("/api/admin/operators", requireAdmin, (req, res) => {
  operatorsOnline = Boolean(req.body?.online);
  res.json({ ok: true, operatorsOnline });
});

// KB status + refresh
app.get("/api/admin/kb/status", requireAdmin, (req, res) => {
  res.json({ ok: true, kbStatus });
});

app.post("/api/admin/kb/refresh", requireAdmin, async (req, res) => {
  try {
    await refreshKnowledge();
    res.json({ ok: true, kbStatus });
  } catch (e) {
    kbStatus.lastError = String(e?.message || e);
    res.status(500).json({ ok: false, kbStatus });
  }
});

// ===========================
// Health
// ===========================
app.get("/", (req, res) => {
  res.type("text").send("Trackmania Events chat service is running.");
});

app.listen(PORT, () => {
  console.log(`Chat service listening on port ${PORT}`);
  console.log(`SITEMAP_URL=${SITEMAP_URL}`);
});
