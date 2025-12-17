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

const OPERATOR_NAME = process.env.OPERATOR_NAME || "Trackmania Events Support";
const OPERATOR_AVATAR_URL =
  process.env.OPERATOR_AVATAR_URL || `${SITE_BASE.replace(/\/+$/,"")}/logo.png`;

const VISITOR_AVATAR_URL =
  process.env.VISITOR_AVATAR_URL || `${SITE_BASE.replace(/\/+$/,"")}/logo.png`;

if (!ADMIN_PASSWORD) console.warn("[WARN] ADMIN_PASSWORD is not set");
if (!AUTH_SECRET) console.warn("[WARN] AUTH_SECRET is not set");
if (!OPENAI_API_KEY) console.warn("[WARN] OPENAI_API_KEY is not set (AI auto-replies disabled)");

app.disable("x-powered-by");
app.use(express.json({ limit: "256kb" }));

// Serve admin UI
app.use("/admin", express.static(path.join(__dirname, "admin"), { extensions: ["html"] }));

// ===========================
// CORS for public site widget
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
// In-memory store
// ===========================
const conversations = new Map();

// Admin presence (online if heartbeat within window)
const ADMIN_ONLINE_WINDOW_MS = 90_000; // 90 seconds
let lastAdminPingAt = 0;

function isAdminOnline() {
  return (Date.now() - lastAdminPingAt) <= ADMIN_ONLINE_WINDOW_MS;
}

let operatorStatus = "offline"; // "online" | "busy" | "offline"


// ===========================
// Helpers
// ===========================
function now() { return Date.now(); }
function newSid() { return crypto.randomBytes(16).toString("hex"); }
function newMsgId() { return `${Date.now()}_${crypto.randomBytes(6).toString("hex")}`; }

function safeText(input) {
  const t = String(input ?? "").trim();
  return t.length > 2000 ? t.slice(0, 2000) : t;
}
function safeName(input) {
  const t = String(input ?? "").trim().replace(/\s+/g, " ");
  const clipped = t.slice(0, 32);
  return clipped || "Visitor";
}
function safeUrl(input) {
  const t = String(input ?? "").trim();
  if (!t) return "";
  try { return new URL(t).toString(); } catch { return ""; }
}

function sleep(ms){ return new Promise(r=>setTimeout(r,ms)); }

function nextTs(convo) {
  const t = now();
  const prev = Number(convo?.updatedAt || 0);
  return t <= prev ? prev + 1 : t;
}

function getCookie(req, name) {
  const header = req.headers.cookie || "";
  const parts = header.split(";").map(p => p.trim());
  for (const p of parts) {
    if (p.startsWith(name + "=")) return decodeURIComponent(p.slice(name.length + 1));
  }
  return null;
}

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

function participantsPayload(convo){
  return {
    visitor: {
      name: convo.visitorName || "Visitor",
      avatarUrl: convo.visitorAvatarUrl || VISITOR_AVATAR_URL,
      email: convo.visitorEmail || "",
    },
    operator: {
      name: OPERATOR_NAME,
      avatarUrl: OPERATOR_AVATAR_URL,
    }
  };
}

function pushMsg(convo, m){
  convo.messages.push(m);
  convo.updatedAt = m.ts;
}

function pushAI(convo, text){
  const ts = nextTs(convo);
  pushMsg(convo, { id: newMsgId(), from: "ai", text, ts });
}

function pushSystem(convo, text){
  const ts = nextTs(convo);
  pushMsg(convo, { id: newMsgId(), from: "system", text, ts });
}

function pushUI(convo, ui){
  const ts = nextTs(convo);
  pushMsg(convo, { id: newMsgId(), from: "system", text: "", ts, kind: "ui", ui });
}

function escalate(convo){
  convo.assignedTo = "admin";
  convo.needsAdmin = true;
}

function agentsAvailable() {
  return operatorStatus === "online";
}

function operatorAutoMessage() {
  if (operatorStatus === "online") return "Transferring you to an agent right now.";
  if (operatorStatus === "busy") return "All agents are currently busy. Please enter your email and we’ll follow up as soon as possible.";
  return "There are no agents online at the moment. Please enter your email and we’ll follow up as soon as possible.";
}

// ===========================
// AI heuristics (your plan)
// ===========================
const ESCALATE_CONFIDENCE_THRESHOLD = 0.40;

function isGreeting(text){
  const t = String(text || "").toLowerCase().trim();
  return /^(hi|hello|hey|yo|sup|good (morning|afternoon|evening))[\s!.]*$/.test(t);
}

function greetingReply(){
  return "Hi. What can I help with—events schedule, TOTD, Kacky, world records, or the chat widget?";
}

function requestsHuman(text){
  const t = String(text || "").toLowerCase();
  return /(operator|human|agent|staff|support|admin|moderator|mod|talk to a person)/.test(t);
}

function shouldEscalateHeuristics(text){
  // Keep this conservative; only obvious cases.
  const t = String(text || "").toLowerCase();
  return /(payment|billing|charge|refund|legal|dmca|harass|abuse|ban appeal)/.test(t);
}

function buildClarifyingQuestion(){
  return "I can help—what page are you on and what are you trying to do (events, TOTD, Kacky, world records, or chat)?";
}

// ===========================
// Knowledge base (kept from your existing design)
// ===========================
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
    out.push(text.slice(i, i + KB_CHUNK_SIZE));
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
      const base = new URL(SITE_BASE);
      if (u.host === base.host) locs.push(u.toString());
    } catch {}
  }
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

      if (text.length < 200) continue;

      const chunks = chunkText(text);
      for (let idx = 0; idx < chunks.length; idx++) {
        newChunks.push({
          id: crypto.createHash("sha1").update(url + ":" + idx).digest("hex"),
          url,
          title,
          text: chunks[idx],
        });
      }
      pageCount++;
      await sleep(60);
    } catch (e) {
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

// Minimal OpenAI call stub (kept simple; you can paste your existing one here)
async function callOpenAI({ question, contextChunks }) {
  // If no key, behave like “no confidence”: ask clarifying question.
  if (!OPENAI_API_KEY) return { reply: buildClarifyingQuestion(), confidence: 0.0, escalate: false };

  const context = contextChunks.map(c => `Title: ${c.title}\nURL: ${c.url}\n${c.text}`).join("\n\n---\n\n");

  const payload = {
    model: AI_MODEL,
    messages: [
      { role: "system", content: "You are the Trackmania Events website assistant. Be concise, accurate, and ask a clarifying question if unsure." },
      { role: "user", content: `Question: ${question}\n\nContext:\n${context}` }
    ],
    temperature: 0.2,
  };

  const r = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${OPENAI_API_KEY}`,
    },
    body: JSON.stringify(payload),
  });

  if (!r.ok) {
    return { reply: buildClarifyingQuestion(), confidence: 0.0, escalate: false };
  }

  const data = await r.json().catch(() => null);
  const reply = data?.choices?.[0]?.message?.content?.trim() || "";
  // You can compute confidence better later; keep stable for now.
  return { reply, confidence: 0.7, escalate: false };
}

// ===========================
// Chat API
// ===========================
app.post("/api/chat/init", (req, res) => {
  const sid = newSid();
  const visitorName = safeName(req.body?.visitorName);
  const createdAt = now();

  const convo = {
    sid,
    status: "open",
    assignedTo: "ai",       // IMPORTANT: default to AI so it responds
    needsAdmin: false,
    visitorName,
    visitorEmail: "",
    visitorAvatarUrl: VISITOR_AVATAR_URL,
    createdAt,
    updatedAt: createdAt,
    messages: [],
  };

  // welcome
  pushAI(convo, "Connected. Ask anything about Trackmania Events.");

  conversations.set(sid, convo);

  res.json({
    ok: true,
    sid,
    status: convo.status,
    serverTime: convo.updatedAt,
    participants: participantsPayload(convo),
  });
});

// Profile endpoint: used by widget to set name/email/avatar cleanly
const EMAIL_RE = /([a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,})/i;

app.post("/api/chat/profile", (req, res) => {
  const sid = safeText(req.body?.sid);
  if (!sid) return res.status(400).json({ ok:false, error:"Missing sid" });

  const convo = conversations.get(sid);
  if (!convo) return res.status(404).json({ ok:false, error:"Conversation not found" });

  const name = req.body?.visitorName != null ? safeName(req.body.visitorName) : null;
  const email = req.body?.visitorEmail != null ? safeText(req.body.visitorEmail) : null;
  const avatarUrl = req.body?.visitorAvatarUrl != null ? safeUrl(req.body.visitorAvatarUrl) : null;

  if (name) {
    convo.visitorName = name;
    pushSystem(convo, `[Visitor set name: ${name}]`);
  }

  if (email) {
    const m = String(email).match(EMAIL_RE);
    if (m) {
      convo.visitorEmail = m[1];
      pushSystem(convo, `[Visitor email captured: ${convo.visitorEmail}]`);
    }
  }

  if (avatarUrl) {
    convo.visitorAvatarUrl = avatarUrl;
    pushSystem(convo, `[Visitor avatar updated]`);
  }

  res.json({ ok:true, sid: convo.sid, status: convo.status, participants: participantsPayload(convo) });
});

app.get("/api/chat/poll", (req, res) => {
  const sid = String(req.query.sid || "").trim();
  const since = Number(req.query.since || 0);

  if (!sid) return res.status(400).json({ ok: false, error: "Missing sid" });

  const convo = conversations.get(sid);
  if (!convo) {
    return res.status(404).json({ ok: false, error: "Conversation not found", status: "missing" });
  }

  const msgs = since > 0 ? convo.messages.filter(m => Number(m.ts || 0) > since) : convo.messages;

  res.json({
    ok: true,
    sid: convo.sid,
    status: convo.status,
    assignedTo: convo.assignedTo,
    needsAdmin: convo.needsAdmin,
    serverTime: now(),
    participants: participantsPayload(convo),
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

  // If escalated and waiting for email, capture it if they typed it
  if (convo.needsAdmin && !convo.visitorEmail) {
    const m = text.match(EMAIL_RE);
    if (m) {
      convo.visitorEmail = m[1];
      pushSystem(convo, `[Visitor email captured: ${convo.visitorEmail}]`);
    }
  }

  const ts = nextTs(convo);
  pushMsg(convo, { id: newMsgId(), from: "visitor", text, ts });

  res.json({
    ok: true,
    sid: convo.sid,
    status: convo.status,
    serverTime: ts,
    participants: participantsPayload(convo),
  });

  // ---- AI auto-reply (fire-and-forget) ----
  if (convo.assignedTo !== "ai" || convo.needsAdmin) return;

  (async () => {
    try {
      // Operator request handling (presence-aware)
      if (requestsHuman(text) || shouldEscalateHeuristics(text)) {
        if (operatorsOnline && isAdminOnline()) {
          pushAI(convo, "Transferring you to an agent right now.");
          escalate(convo);
        } else {
          pushAI(convo, "There are no agents online at the moment. Please enter your email address and we’ll get back to you as soon as possible.");
          convo.assignedTo = "admin";
          convo.needsAdmin = true;
          pushUI(convo, { kind: "email_capture" });
        }
        return;
      }

      if (isGreeting(text)) {
        pushAI(convo, greetingReply());
        return;
      }

      const hits = searchKB(text, 6);
      if (!kbChunks.length || hits.length === 0) {
        pushAI(convo, buildClarifyingQuestion());
        return;
      }

      const result = await callOpenAI({ question: text, contextChunks: hits });

      const lowConfidence = (result.escalate || result.confidence < ESCALATE_CONFIDENCE_THRESHOLD);
      if (lowConfidence) {
        pushAI(convo, buildClarifyingQuestion());
        return;
      }

      pushAI(convo, result.reply || buildClarifyingQuestion());
    } catch {
      pushAI(convo, "Sorry—something hiccupped on my end. What page/feature is this about (events, TOTD, Kacky, world records, or chat widget)?");
    }
  })();
});

// ===========================
// Admin API
// ===========================
function convoSummary(convo){
  const last = convo.messages.slice(-1)[0];
  return {
    sid: convo.sid,
    status: convo.status,
    assignedTo: convo.assignedTo,
    needsAdmin: convo.needsAdmin,
    visitorName: convo.visitorName || "Visitor",
    visitorEmail: convo.visitorEmail || "",
    updatedAt: convo.updatedAt,
    preview: last?.text ? String(last.text).slice(0, 120) : (last?.kind === "ui" ? "[UI]" : ""),
  };
}

function getConvoOr404(sid, res){
  const convo = conversations.get(sid);
  if (!convo) {
    res.status(404).json({ ok:false, error:"Conversation not found" });
    return null;
  }
  return convo;
}

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

// Presence heartbeat (admin page calls this every 30s)
app.post("/api/admin/presence", requireAdmin, (req, res) => {
  lastAdminPingAt = Date.now();
  res.json({ ok: true, adminOnline: true, lastAdminPingAt });
});

app.get("/api/admin/conversations", requireAdmin, (req, res) => {
  const list = [...conversations.values()]
    .sort((a, b) => b.updatedAt - a.updatedAt)
    .map(convoSummary);

  res.json({
    ok: true,
    conversations: list,
    operatorStatus, // "online" | "busy" | "offline"
    kbStatus
  });
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
    visitorName: convo.visitorName,
    participants: participantsPayload(convo),
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

  const ts = nextTs(convo);
  pushMsg(convo, { id: newMsgId(), from: "admin", text, ts });

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

  const ts = nextTs(convo);
  convo.status = "closed";
  pushMsg(convo, { id: newMsgId(), from: "system", text: "[Chat ended by admin]", ts });

  res.json({ ok: true, sid: convo.sid, status: convo.status, serverTime: ts });
});

// Operators toggle (manual)
app.get("/api/admin/operators", requireAdmin, (req, res) => {
  res.json({ ok: true, operatorStatus });
});

app.post("/api/admin/operators", requireAdmin, (req, res) => {
  const status = String(req.body?.status || "").toLowerCase();
  if (!["online", "busy", "offline"].includes(status)) {
    return res.status(400).json({ ok: false, error: "Invalid status" });
  }
  operatorStatus = status;
  res.json({ ok: true, operatorStatus });
});


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

// Health
app.get("/", (req, res) => {
  res.type("text").send("Trackmania Events chat service is running.");
});

app.listen(PORT, () => {
  console.log(`Chat service listening on port ${PORT}`);
  console.log(`SITEMAP_URL=${SITEMAP_URL}`);
  console.log(`OPERATOR_NAME=${OPERATOR_NAME}`);
  console.log(`OPERATOR_AVATAR_URL=${OPERATOR_AVATAR_URL}`);

  (async () => {
    try {
      await refreshKnowledge();
      console.log("[KB] initial refresh complete", kbStatus);
    } catch (e) {
      console.warn("[KB] initial refresh failed", e?.message || e);
    }
  })();
});
