// server.js (ESM)
import express from "express";
import cookieParser from "cookie-parser";
import crypto from "crypto";
import path from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();

const PORT = process.env.PORT || 3000;
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || "";
const AUTH_SECRET = process.env.AUTH_SECRET || "";

// Basic sanity: fail loud in logs (but still start so you can see it)
if (!ADMIN_PASSWORD) console.warn("[WARN] ADMIN_PASSWORD is not set");
if (!AUTH_SECRET) console.warn("[WARN] AUTH_SECRET is not set");

// ---- In-memory store (note: resets only if the Render instance restarts) ----
/**
 * conversations: Map<sid, {
 *   sid: string,
 *   status: "open"|"closed",
 *   createdAt: number,
 *   updatedAt: number,
 *   messages: Array<{ from:"visitor"|"admin"|"system", text:string, ts:number }>
 * }>
 */
const conversations = new Map();

// ---- middleware ----
app.disable("x-powered-by");
app.use(express.json({ limit: "256kb" }));
app.use(cookieParser());

// Serve admin UI
app.use("/admin", express.static(path.join(__dirname, "admin"), { extensions: ["html"] }));

// ---- utilities ----
function now() {
  return Date.now();
}

function newSid() {
  // short, URL-safe id
  return crypto.randomBytes(16).toString("hex");
}

function safeText(input) {
  const t = String(input ?? "").trim();
  // Prevent absurd payloads
  if (t.length > 2000) return t.slice(0, 2000);
  return t;
}

// ---- CORS for public widget endpoints (no cookies needed) ----
function publicCors(req, res, next) {
  // widget does NOT need cookies; allow any origin
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  res.setHeader("Access-Control-Max-Age", "86400");
  if (req.method === "OPTIONS") return res.sendStatus(204);
  next();
}

// ---- simple signed cookie auth for admin ----
const ADMIN_COOKIE_NAME = "tme_admin";
function signToken(payload) {
  // payload is string
  const h = crypto.createHmac("sha256", AUTH_SECRET).update(payload).digest("hex");
  return `${payload}.${h}`;
}
function verifyToken(token) {
  if (!token || typeof token !== "string") return null;
  const idx = token.lastIndexOf(".");
  if (idx <= 0) return null;
  const payload = token.slice(0, idx);
  const sig = token.slice(idx + 1);
  const expected = crypto.createHmac("sha256", AUTH_SECRET).update(payload).digest("hex");
  try {
    const a = Buffer.from(sig, "hex");
    const b = Buffer.from(expected, "hex");
    if (a.length !== b.length) return null;
    if (!crypto.timingSafeEqual(a, b)) return null;
  } catch {
    return null;
  }
  return payload;
}

function requireAdmin(req, res, next) {
  if (!AUTH_SECRET) return res.status(500).json({ ok: false, error: "AUTH_SECRET not configured" });
  const token = req.cookies?.[ADMIN_COOKIE_NAME];
  const payload = verifyToken(token);
  if (!payload) return res.status(401).json({ ok: false, error: "Unauthorized" });

  // payload format: "v1:<iat>:<nonce>"
  if (!payload.startsWith("v1:")) return res.status(401).json({ ok: false, error: "Unauthorized" });
  next();
}

// ---- helpers to shape responses consistently ----
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
// Public Chat API (widget)
// ===========================

app.post("/api/chat/init", publicCors, (req, res) => {
  const sid = newSid();
  const ts = now();
  const convo = {
    sid,
    status: "open",
    createdAt: ts,
    updatedAt: ts,
    messages: [
      { from: "system", text: "Chat started.", ts },
    ],
  };
  conversations.set(sid, convo);
  res.json({ ok: true, sid, status: convo.status });
});

app.get("/api/chat/poll", publicCors, (req, res) => {
  const sid = String(req.query.sid || "").trim();
  const since = Number(req.query.since || 0);

  if (!sid) return res.status(400).json({ ok: false, error: "Missing sid" });

  const convo = conversations.get(sid);
  if (!convo) {
    // widget should treat as missing -> clear sid -> init new
    return res.status(404).json({ ok: false, error: "Conversation not found", status: "missing" });
  }

  const msgs = since > 0
    ? convo.messages.filter(m => m.ts > since)
    : convo.messages;

  res.json({
    ok: true,
    sid: convo.sid,
    status: convo.status,
    serverTime: now(),
    messages: msgs,
  });
});

app.post("/api/chat/send", publicCors, (req, res) => {
  const sid = safeText(req.body?.sid);
  const text = safeText(req.body?.text);

  if (!sid) return res.status(400).json({ ok: false, error: "Missing sid" });
  if (!text) return res.status(400).json({ ok: false, error: "Missing text" });

  const convo = conversations.get(sid);
  if (!convo) return res.status(404).json({ ok: false, error: "Conversation not found", status: "missing" });

  if (convo.status === "closed") {
    return res.status(409).json({ ok: false, error: "Chat is closed", status: convo.status });
  }

  const ts = now();
  convo.messages.push({ from: "visitor", text, ts });
  convo.updatedAt = ts;

  res.json({ ok: true, sid: convo.sid, status: convo.status, serverTime: ts });
});

// ===========================
// Admin Auth + Admin API
// ===========================

app.post("/api/admin/login", (req, res) => {
  if (!AUTH_SECRET) return res.status(500).json({ ok: false, error: "AUTH_SECRET not configured" });

  const password = safeText(req.body?.password);
  if (!password) return res.status(400).json({ ok: false, error: "Missing password" });

  if (!ADMIN_PASSWORD || password !== ADMIN_PASSWORD) {
    return res.status(401).json({ ok: false, error: "Invalid password" });
  }

  const payload = `v1:${now()}:${crypto.randomBytes(12).toString("hex")}`;
  const token = signToken(payload);

  // Cookie works when /admin is served from same origin: trackmaniaevents-chat.onrender.com
  res.cookie(ADMIN_COOKIE_NAME, token, {
    httpOnly: true,
    sameSite: "lax",
    secure: true, // Render is https
    path: "/",
    maxAge: 1000 * 60 * 60 * 24 * 7, // 7 days
  });

  res.json({ ok: true });
});

app.post("/api/admin/logout", requireAdmin, (req, res) => {
  res.clearCookie(ADMIN_COOKIE_NAME, { path: "/" });
  res.json({ ok: true });
});

app.get("/api/admin/conversations", requireAdmin, (req, res) => {
  const list = [...conversations.values()]
    .sort((a, b) => (b.updatedAt - a.updatedAt))
    .map(convoSummary);

  res.json({ ok: true, conversations: list });
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
    return res.status(409).json({ ok: false, error: "Chat is closed", status: convo.status });
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
    return res.json({ ok: true, sid: convo.sid, status: convo.status });
  }

  const ts = now();
  convo.status = "closed";
  convo.messages.push({ from: "system", text: "[Chat ended by admin]", ts });
  convo.updatedAt = ts;

  res.json({ ok: true, sid: convo.sid, status: convo.status, serverTime: ts });
});

// ---- simple health ----
app.get("/", (req, res) => {
  res.type("text").send("Trackmania Events chat service is running.");
});

app.listen(PORT, () => {
  console.log(`Chat service listening on port ${PORT}`);
});
