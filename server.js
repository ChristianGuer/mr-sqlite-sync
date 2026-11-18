require("dotenv").config();
const express = require("express");
const { openDb, all, computeScores } = require("./scoring");

const app = express();
const PORT = process.env.PORT || 3001;
const DB_PATH = process.env.MR_DB_PATH || "./marvelrivals.db";

// ─── Middleware ──────────────────────────────────────────────────────────────
app.use(express.json());
app.use((req, res, next) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.sendStatus(204);
  next();
});

// ─── Routes ─────────────────────────────────────────────────────────────────

// GET /heroes — full hero roster for building the selection UI
app.get("/heroes", async (req, res) => {
  let db;
  try {
    db = await openDb(DB_PATH);
    const heroes = await all(db, `SELECT hero_id, name, role FROM heroes ORDER BY name;`);
    res.json({ heroes });
  } catch (e) {
    res.status(500).json({ error: e.message });
  } finally {
    if (db) db.close();
  }
});

// POST /recommendations — body: { enemyIds: [hero_id, ...] }
// Returns top 5 hero picks scored against the given enemy comp
app.post("/recommendations", async (req, res) => {
  const { enemyIds } = req.body ?? {};

  if (!Array.isArray(enemyIds) || enemyIds.length === 0) {
    return res.status(400).json({ error: "enemyIds must be a non-empty array of hero IDs" });
  }
  if (enemyIds.length > 6) {
    return res.status(400).json({ error: "enemyIds cannot exceed 6 heroes" });
  }

  let db;
  try {
    db = await openDb(DB_PATH);
    const { results, globalWR } = await computeScores(db, enemyIds.map(Number));
    res.json({ recommendations: results, global_wr: Math.round(globalWR * 100) });
  } catch (e) {
    res.status(500).json({ error: e.message });
  } finally {
    if (db) db.close();
  }
});

// ─── Start ───────────────────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`Marvel Rivals server running on http://localhost:${PORT}`);
});
