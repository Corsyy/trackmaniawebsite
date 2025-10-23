import express from "express";
import fetch from "node-fetch";

const app = express();

// ===== CORS =====
app.use((req, res, next) => {
  // allow your GitHub Pages site to talk to this backend
  res.setHeader("Access-Control-Allow-Origin", "https://trackmaniaevents.com");
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
  if (req.method === "OPTIONS") return res.sendStatus(200);
  next();
});

// ===== Simple health checks =====
app.get("/", (_req, res) => res.send("OK"));
app.get("/healthz", (_req, res) => res.json({ ok: true }));
app.get("/api/ping", (_req, res) => res.json({ ok: true, ts: Date.now() }));

// ===== Example WR leaderboard endpoint =====
app.get("/api/wr-leaderboard", async (_req, res) => {
  try {
    // dummy data for now — replace later with your real Nadeo Live Services call
    const leaderboard = [
      { mapUid: "JxA123", holder: "PlayerOne", timeMs: 50342, timestamp: Date.now() / 1000 },
      { mapUid: "ZqB456", holder: "PlayerTwo", timeMs: 51211, timestamp: Date.now() / 1000 },
      { mapUid: "NcC789", holder: "PlayerThree", timeMs: 51994, timestamp: Date.now() / 1000 },
    ];

    res.json({
      rows: leaderboard,
      fetchedAt: Date.now(),
    });
  } catch (err) {
    console.error("WR leaderboard error:", err);
    res.status(500).json({ error: "Failed to load leaderboard" });
  }
});

// ===== Server listen =====
// IMPORTANT: use Render's assigned port and bind to 0.0.0.0
const PORT = process.env.PORT || 3000;
app.listen(PORT, "0.0.0.0", () => console.log(`✅ API running on port ${PORT}`));
