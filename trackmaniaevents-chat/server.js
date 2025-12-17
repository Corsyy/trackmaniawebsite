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

if (!ADMIN_PASSWORD) console.warn("[WARN] ADMIN_PASSWORD is not set");
if (!AUTH_SECRET) console.warn("[WARN] AUTH_SECRET is not set");

// ===========================
// In-memory store
// ===========================
/**
 * Map<sid, {
 *   sid: string,
 *   status: "open"|"closed",
 *   createdAt: number,
 *   updatedAt: number,
 *   messages: Array<{ from:"visitor"|"admin"|"system", text:string, ts:number }>
 * }>
 */
const conversations = new Map();

// ===========================
// Middleware
// ===========================
app.disable("x-powered-by");
app.use(express.json({ limit: "256kb" }));

// Serve admin UI
app.use("/admin", express.static(path.join(__dirname, "admin"), { extensions: ["html"] }));

// ===========================
// CORS (for public widget)
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
function now() {
  return Date.now();
}

function newSid() {
  return crypto.randomBytes(16).toString("hex");
}

function safeText(input) {
  const t = String(input ?? "").trim();
  return t.length > 2000 ? t.slice(0, 2000) : t;
}

// ===========================
// Cookie helpers (NO cookie-parser)
// ===========================
function getCookie(req, name) {
  const header = req.headers.cookie || "";
  const parts = header.split(";").map(p => p.trim());
  for (const p of parts) {
    if (p.startsWith(name + "=")) {
      return decodeURIComponent(p.slice(name.length + 1));
    }
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
  if (!AUTH_SECRET) return res.status(500).json({ ok: false, error: "AUTH_SECRET not configured" });
  const token = getCookie(req, ADMIN_COOKIE_NAME);
  const payload = verifyToken(token);
  if (!payload || !payload.startsWith("v1:")) {
    return res.status(401).json({ ok: false, error: "Unauthorized" });
  }
  next();
}

// ===========================
// Helpers
// ===========================
function convoSummary(c) {
  const last = c.messages[c.messages.length - 1];
  return {
    sid: c.sid,
    status: c.status,
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

  conversations.set(sid, {
    sid,
    status: "open",
    createdAt: ts,
    updatedAt: ts,
    messages: [{ from: "system", text: "Chat started.", ts }],
  });

  res.json({ ok: true, sid, status: "open" });
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

  const ts = now();
  convo.messages.push({ from: "visitor", text, ts });
  convo.updatedAt = ts;

  res.json({ ok: true, sid: convo.sid, status: convo.status, serverTime: ts });
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

  res.json({ ok: true, conversations: list });
});

// REQUIRED by your admin UI
app.get("/api/admin/conversation", requireAdmin, (req, res) => {
  const sid = String(req.query.sid || "").trim();
  if (!sid) return res.status(400).json({ ok: false, error: "Missing sid" });

  const convo = getConvoOr404(sid, res);
  if (!convo) return;

  res.json({
    ok: true,
    sid: convo.sid,
    status: convo.status,
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

// ===========================
// Health
// ===========================
app.get("/", (req, res) => {
  res.type("text").send("Trackmania Events chat service is running.");
});

app.listen(PORT, () => {
  console.log(`Chat service listening on port ${PORT}`);
});
