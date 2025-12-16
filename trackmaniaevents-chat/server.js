// trackmaniaevents-chat/server.js
import express from "express";
import compression from "compression";
import path from "path";
import fs from "fs";
import crypto from "crypto";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
app.disable("x-powered-by");

app.use(compression());
app.use(express.json({ limit: "256kb" }));

// -------------------- CONFIG --------------------
const PORT = process.env.PORT || 3000;

// Set in Render Environment:
// ADMIN_PASSWORD = "your-strong-password"
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || "";

// Used to sign cookies/tokens (set in Render Environment)
// AUTH_SECRET = "random-long-secret"
const AUTH_SECRET =
  process.env.AUTH_SECRET || crypto.randomBytes(32).toString("hex");

// Data directory inside this service (trackmaniaevents-chat/data)
const DATA_DIR = path.join(__dirname, "data");
const DATA_FILE = path.join(DATA_DIR, "chat-store.json");

// -------------------- SIMPLE STORE --------------------
function ensureStore() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  if (!fs.existsSync(DATA_FILE)) {
    fs.writeFileSync(
      DATA_FILE,
      JSON.stringify({ conversations: {} }, null, 2),
      "utf8"
    );
  }
}

function readStore() {
  ensureStore();
  try {
    return JSON.parse(fs.readFileSync(DATA_FILE, "utf8"));
  } catch {
    return { conversations: {} };
  }
}

function writeStore(store) {
  ensureStore();
  fs.writeFileSync(DATA_FILE, JSON.stringify(store, null, 2), "utf8");
}

function nowIso() {
  return new Date().toISOString();
}

function safeText(s) {
  return String(s || "").slice(0, 2000);
}

function makeId(prefix = "") {
  return prefix + crypto.randomBytes(8).toString("hex");
}

// -------------------- AUTH (admin) --------------------
const adminSessions = new Map(); // token -> { exp:number }

function signToken(raw) {
  const h = crypto.createHmac("sha256", AUTH_SECRET).update(raw).digest("hex");
  return `${raw}.${h}`;
}

function verifyToken(token) {
  const parts = String(token || "").split(".");
  if (parts.length !== 2) return false;
  const [raw, sig] = parts;
  const h = crypto.createHmac("sha256", AUTH_SECRET).update(raw).digest("hex");
  return crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(h));
}

function parseCookies(req) {
  const header = req.headers.cookie || "";
  const out = {};
  header.split(";").forEach((p) => {
    const i = p.indexOf("=");
    if (i === -1) return;
    const k = p.slice(0, i).trim();
    const v = p.slice(i + 1).trim();
    if (k) out[k] = decodeURIComponent(v);
  });
  return out;
}

function requireAdmin(req, res, next) {
  const cookies = parseCookies(req);
  const token = cookies.admin_session;
  if (!token || !verifyToken(token))
    return res.status(401).json({ error: "unauthorized" });

  const raw = token.split(".")[0];
  const sess = adminSessions.get(raw);
  if (!sess || sess.exp < Date.now())
    return res.status(401).json({ error: "expired" });

  next();
}

// -------------------- BASIC RATE LIMIT (per IP) --------------------
const rl = new Map(); // key -> { count, resetAt }
function rateLimit(key, limit, windowMs) {
  const now = Date.now();
  const cur = rl.get(key);
  if (!cur || cur.resetAt < now) {
    rl.set(key, { count: 1, resetAt: now + windowMs });
    return true;
  }
  if (cur.count >= limit) return false;
  cur.count++;
  return true;
}

// -------------------- STATIC: admin UI (Option A) --------------------
// Folder: trackmaniaevents-chat/admin/index.html
const ADMIN_DIR = path.join(__dirname, "admin");

app.use(
  "/admin",
  express.static(ADMIN_DIR, {
    extensions: ["html"],
    setHeaders(res) {
      res.setHeader("Cache-Control", "no-store");
    },
  })
);

// Ensure /admin and /admin/ both load the UI
app.get("/admin", (req, res) => {
  res.sendFile(path.join(ADMIN_DIR, "index.html"));
});
app.get("/admin/", (req, res) => {
  res.sendFile(path.join(ADMIN_DIR, "index.html"));
});

// -------------------- API: visitor --------------------
// Create/get conversation
app.post("/api/chat/init", (req, res) => {
  const ip =
    req.headers["x-forwarded-for"]?.toString().split(",")[0]?.trim() ||
    req.socket.remoteAddress ||
    "unknown";
  if (!rateLimit(`init:${ip}`, 30, 60_000))
    return res.status(429).json({ error: "rate_limited" });

  const store = readStore();

  let sid = safeText(req.body?.sid);

  // If sid is missing or unknown -> create
  if (!sid || !store.conversations[sid]) {
    sid = makeId("c_");
    store.conversations[sid] = {
      id: sid,
      createdAt: nowIso(),
      lastAt: nowIso(),
      title: "Visitor",
      status: "open",
      messages: [],
    };
    writeStore(store);
  }

  // If sid exists but was closed, we still return it here;
  // your website widget should detect status via /poll and create a new sid.
  res.json({ sid });
});

// Post message (visitor or admin)
app.post("/api/chat/message", (req, res) => {
  const ip =
    req.headers["x-forwarded-for"]?.toString().split(",")[0]?.trim() ||
    req.socket.remoteAddress ||
    "unknown";
  if (!rateLimit(`msg:${ip}`, 120, 60_000))
    return res.status(429).json({ error: "rate_limited" });

  const { sid, from, text } = req.body || {};
  if (!sid) return res.status(400).json({ error: "missing_sid" });
  const who = from === "admin" ? "admin" : "visitor";
  const msgText = safeText(text).trim();
  if (!msgText) return res.status(400).json({ error: "empty" });

  // If admin is posting, enforce auth
  if (who === "admin") {
    const cookies = parseCookies(req);
    const token = cookies.admin_session;
    if (!token || !verifyToken(token))
      return res.status(401).json({ error: "unauthorized" });
    const raw = token.split(".")[0];
    const sess = adminSessions.get(raw);
    if (!sess || sess.exp < Date.now())
      return res.status(401).json({ error: "expired" });
  }

  const store = readStore();
  const conv = store.conversations[sid];
  if (!conv) return res.status(404).json({ error: "unknown_conversation" });

  // Don’t allow messages into closed chats (keeps the “end chat” behavior clean)
  if ((conv.status || "open").toLowerCase() === "closed") {
    return res.status(409).json({ error: "conversation_closed" });
  }

  const msg = {
    id: makeId("m_"),
    at: nowIso(),
    from: who,
    text: msgText,
  };

  conv.messages.push(msg);
  conv.lastAt = msg.at;

  // lightweight title: first visitor message
  if (who === "visitor" && conv.title === "Visitor") {
    conv.title = msgText.slice(0, 40);
  }

  writeStore(store);
  res.json({ ok: true, msg });
});

// Poll messages since a timestamp (ISO string)
app.get("/api/chat/poll", (req, res) => {
  const sid = String(req.query.sid || "");
  const since = String(req.query.since || "");

  const store = readStore();
  const conv = store.conversations[sid];
  if (!conv) return res.status(404).json({ error: "unknown_conversation" });

  const sinceTime = since ? Date.parse(since) : 0;
  const msgs = conv.messages.filter((m) => Date.parse(m.at) > sinceTime);

  res.json({
    sid,
    status: conv.status || "open",
    messages: msgs,
    lastAt: conv.lastAt,
  });
});

// -------------------- API: admin --------------------
app.post("/api/admin/login", (req, res) => {
  const ip =
    req.headers["x-forwarded-for"]?.toString().split(",")[0]?.trim() ||
    req.socket.remoteAddress ||
    "unknown";
  if (!rateLimit(`login:${ip}`, 20, 60_000))
    return res.status(429).json({ error: "rate_limited" });

  if (!ADMIN_PASSWORD)
    return res.status(500).json({ error: "ADMIN_PASSWORD_not_set" });

  const pw = safeText(req.body?.password);
  if (!pw || pw !== ADMIN_PASSWORD)
    return res.status(401).json({ error: "invalid" });

  const raw = makeId("s_");
  const token = signToken(raw);

  // 12 hours session
  adminSessions.set(raw, { exp: Date.now() + 12 * 60 * 60 * 1000 });

  // httpOnly cookie so JS can’t read it
  res.setHeader("Set-Cookie", [
    `admin_session=${encodeURIComponent(
      token
    )}; Path=/; HttpOnly; SameSite=Lax; Secure`,
  ]);

  res.json({ ok: true });
});

app.post("/api/admin/logout", (req, res) => {
  const cookies = parseCookies(req);
  const token = cookies.admin_session;
  if (token && verifyToken(token)) {
    const raw = token.split(".")[0];
    adminSessions.delete(raw);
  }
  res.setHeader("Set-Cookie", [
    `admin_session=; Path=/; HttpOnly; SameSite=Lax; Secure; Max-Age=0`,
  ]);
  res.json({ ok: true });
});

// End a chat (admin only)
app.post("/api/admin/close", requireAdmin, (req, res) => {
  const sid = safeText(req.body?.sid);
  if (!sid) return res.status(400).json({ error: "missing_sid" });

  const store = readStore();
  const conv = store.conversations[sid];
  if (!conv) return res.status(404).json({ error: "unknown_conversation" });

  conv.status = "closed";
  conv.closedAt = nowIso();
  conv.lastAt = nowIso();

  conv.messages.push({
    id: makeId("m_"),
    at: nowIso(),
    from: "admin",
    text: "[Chat ended by admin]",
  });

  writeStore(store);
  res.json({ ok: true });
});

app.get("/api/admin/conversations", requireAdmin, (req, res) => {
  const store = readStore();
  const list = Object.values(store.conversations)
    .map((c) => ({
      id: c.id,
      title: c.title,
      status: c.status || "open",
      createdAt: c.createdAt,
      lastAt: c.lastAt,
      lastMsg: c.messages[c.messages.length - 1]?.text?.slice(0, 80) || "",
    }))
    .sort((a, b) => Date.parse(b.lastAt) - Date.parse(a.lastAt));

  res.json({ conversations: list });
});

app.get("/api/admin/conversation", requireAdmin, (req, res) => {
  const sid = String(req.query.sid || "");
  const since = String(req.query.since || "");

  const store = readStore();
  const conv = store.conversations[sid];
  if (!conv) return res.status(404).json({ error: "unknown_conversation" });

  const sinceTime = since ? Date.parse(since) : 0;
  const msgs = conv.messages.filter((m) => Date.parse(m.at) > sinceTime);

  res.json({
    id: conv.id,
    title: conv.title,
    status: conv.status || "open",
    createdAt: conv.createdAt,
    lastAt: conv.lastAt,
    messages: msgs,
  });
});

// -------------------- HEALTH --------------------
app.get("/healthz", (req, res) => res.json({ ok: true }));

app.listen(PORT, () => {
  console.log(`Chat server running on :${PORT}`);
});
