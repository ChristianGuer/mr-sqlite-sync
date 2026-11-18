// recommend.js
// Recommends which hero YOU should pick based on the enemy team composition.
// Scoring gets smarter the more matches you sync — small sample sizes are
// automatically discounted via Bayesian smoothing so a 1/1 record doesn't
// outrank a 15/20 record.
//
// Usage:
//   node recommend.js "Magneto" "Scarlet Witch" "Iron Fist" "Luna Snow" "Wolverine"
//
// Or interactive mode (no args):
//   node recommend.js

require("dotenv").config();
const readline = require("readline");
const { openDb, all, computeScores, TOP_N } = require("../scoring");

const DB_PATH = process.env.MR_DB_PATH || "./marvelrivals.db";

// ─── Fuzzy hero name matching ───────────────────────────────────────────────
// Lets you type "magik" or "Iron fist" or "jeff" and still find the hero
function normalize(str) {
  return str.toLowerCase().replace(/[^a-z0-9]/g, "");
}

function findHero(input, heroList) {
  const needle = normalize(input);
  // Exact match first
  let match = heroList.find((h) => normalize(h.name) === needle);
  if (match) return match;
  // Starts-with match
  match = heroList.find((h) => normalize(h.name).startsWith(needle));
  if (match) return match;
  // Contains match
  match = heroList.find((h) => normalize(h.name).includes(needle));
  return match || null;
}

// ─── Core scoring ──────────────────────────────────────────────────────────
// For each hero YOU could play, we compute a score between 0-100 based on:
//
//   1. GLOBAL baseline  — your overall win rate on this hero across all matches
//   2. COUNTER signal   — for each enemy hero, your win rate on this hero
//                         when that specific enemy was in the game
//   3. Bayesian blend   — each signal is blended with the global prior
//                         proportional to sample size, so thin data doesn't
//                         produce misleading recommendations
//
// Score formula per candidate hero H against enemy list E:
//
//   baseline   = bayesian(global_wr(H), global_games(H))
//   per_enemy  = average of bayesian(wr(H vs Ei), games(H vs Ei)) for each Ei
//   final      = weighted blend of baseline + per_enemy
//              (per_enemy weight grows as more matchup data accumulates)

function bayesian(wins, games, prior, C) {
  // Blends personal win rate with global prior
  // As games → ∞, result → personal win rate
  // As games → 0,  result → prior
  return (wins + C * prior) / (games + C);
}

async function computeScores(db, enemyHeroIds) {
  // ── 1. Global prior: your overall win rate across all heroes ──
  const [globalRow] = await all(db, `
    SELECT
      SUM(is_win) * 1.0 / COUNT(*) AS global_wr
    FROM match_players
    WHERE is_me = 1 AND is_win IS NOT NULL;
  `);
  const globalWR = globalRow?.global_wr ?? 0.5;

  // ── 2. Your stats per hero (baseline) ──
  const heroStats = await all(db, `
    SELECT
      mp.cur_hero_id                          AS hero_id,
      mp.cur_hero_name                        AS hero_name,
      COUNT(*)                                AS games,
      SUM(mp.is_win)                          AS wins,
      SUM(mp.is_win) * 1.0 / COUNT(*)        AS raw_wr
    FROM match_players mp
    WHERE mp.is_me = 1
      AND mp.is_win IS NOT NULL
      AND mp.cur_hero_id IS NOT NULL
    GROUP BY mp.cur_hero_id
    ORDER BY games DESC;
  `);

  if (heroStats.length === 0) {
    throw new Error("No personal hero data found. Run sync_marvelrivals.js first.");
  }

  // ── 3. For each of your heroes, compute win rate vs each enemy hero ──
  // One query: for each (my_hero, enemy_hero) pair, count games and wins
  const matchupRows = await all(db, `
    SELECT
      mp_me.cur_hero_id     AS my_hero_id,
      mp_me.cur_hero_name   AS my_hero_name,
      mp_enemy.cur_hero_id  AS enemy_hero_id,
      COUNT(*)              AS games,
      SUM(mp_me.is_win)     AS wins
    FROM match_players mp_me
    JOIN match_players mp_enemy
      ON  mp_enemy.match_uid = mp_me.match_uid
      AND mp_enemy.camp      != mp_me.camp
    JOIN matches m
      ON  m.match_uid = mp_me.match_uid
    WHERE mp_me.is_me = 1
      AND mp_me.is_win IS NOT NULL
      AND mp_me.cur_hero_id IS NOT NULL
      AND mp_enemy.cur_hero_id IN (${enemyHeroIds.map(() => "?").join(",")})
    GROUP BY mp_me.cur_hero_id, mp_enemy.cur_hero_id;
  `, enemyHeroIds);

  // Index matchup rows by (my_hero_id, enemy_hero_id) for fast lookup
  const matchupIndex = {};
  for (const row of matchupRows) {
    const key = `${row.my_hero_id}:${row.enemy_hero_id}`;
    matchupIndex[key] = row;
  }

  // ── 4. Score each candidate hero ──
  const results = [];

  for (const hs of heroStats) {
    const baselineScore = bayesian(hs.wins, hs.games, globalWR, BAYES_C);

    // For each enemy hero, get the specific matchup signal
    const counterSignals = [];
    let totalMatchupGames = 0;

    for (const enemyId of enemyHeroIds) {
      const key = `${hs.hero_id}:${enemyId}`;
      const mu = matchupIndex[key];

      if (mu && mu.games > 0) {
        const signal = bayesian(mu.wins, mu.games, globalWR, BAYES_C);
        counterSignals.push({ signal, games: mu.games });
        totalMatchupGames += mu.games;
      } else {
        // No data for this matchup — fall back to baseline
        counterSignals.push({ signal: baselineScore, games: 0 });
      }
    }

    // Average the counter signals
    const avgCounterSignal =
      counterSignals.reduce((sum, s) => sum + s.signal, 0) / counterSignals.length;

    // Blend baseline and counter signal.
    // Weight of counter signal grows with matchup data confidence.
    // With 0 matchup games → pure baseline
    // With 10+ matchup games → mostly counter signal
    const counterWeight = Math.min(totalMatchupGames / (totalMatchupGames + BAYES_C * enemyHeroIds.length), 0.8);
    const finalScore = (1 - counterWeight) * baselineScore + counterWeight * avgCounterSignal;

    results.push({
      hero_id:        hs.hero_id,
      hero_name:      hs.hero_name ?? `hero_id:${hs.hero_id}`,
      score:          Math.round(finalScore * 100),
      games:          hs.games,
      wins:           hs.wins,
      personal_wr:    Math.round((hs.raw_wr ?? 0) * 100),
      matchup_games:  totalMatchupGames,
      counter_signals: counterSignals,
    });
  }

  // Sort by score descending
  results.sort((a, b) => b.score - a.score);
  return { results, globalWR };
}

// ─── Display ───────────────────────────────────────────────────────────────
function capitalize(str) {
  return str.replace(/\b\w/g, (c) => c.toUpperCase());
}

function renderBar(score, width = 20) {
  const filled = Math.round((score / 100) * width);
  return "█".repeat(filled) + "░".repeat(width - filled);
}

function printRecommendations(results, enemyNames, globalWR, heroList) {
  console.log("\n" + "═".repeat(54));
  console.log("  HERO RECOMMENDATIONS");
  console.log("═".repeat(54));
  console.log(`  Enemy team: ${enemyNames.map(capitalize).join(", ")}`);
  console.log(`  Your overall win rate: ${Math.round(globalWR * 100)}%`);
  console.log("─".repeat(54));

  const top = results.slice(0, TOP_N);

  for (let i = 0; i < top.length; i++) {
    const r = top[i];
    const name = capitalize(r.hero_name);
    const bar = renderBar(r.score);
    const confidence = r.matchup_games === 0
      ? "no matchup data yet"
      : `${r.matchup_games} matchup game${r.matchup_games !== 1 ? "s" : ""}`;

    console.log(`\n  #${i + 1}  ${name}`);
    console.log(`       Score: ${bar} ${r.score}/100`);
    console.log(`       Your stats: ${r.wins}W/${r.games - r.wins}L (${r.personal_wr}% WR overall)`);
    console.log(`       Counter data: ${confidence}`);
  }

  console.log("\n" + "─".repeat(54));

  // Warn if dataset is small
  const totalGames = results[0]?.games ?? 0;
  if (results.reduce((s, r) => s + r.matchup_games, 0) < 10) {
    console.log("  ⚠  Low matchup data — sync more matches for better picks.");
    console.log("     Scores are leaning on your overall win rates for now.");
  } else {
    console.log("  ✓  Scores weighted by your personal counter-pick history.");
  }

  console.log("═".repeat(54) + "\n");
}

// ─── Input handling ────────────────────────────────────────────────────────
async function getEnemyHeroes(heroList) {
  // If args were passed on command line, use those
  const args = process.argv.slice(2);
  if (args.length > 0) {
    const resolved = [];
    for (const arg of args) {
      const hero = findHero(arg, heroList);
      if (!hero) {
        console.error(`  ✗ Could not find hero: "${arg}"`);
        console.error(`    Available heroes: ${heroList.map((h) => h.name).join(", ")}`);
        process.exit(1);
      }
      resolved.push(hero);
    }
    return resolved;
  }

  // Otherwise interactive prompt
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const ask = (q) => new Promise((res) => rl.question(q, res));

  console.log("\nEnter enemy heroes one at a time (or comma-separated).");
  console.log("Type 'done' or press Enter on empty line when finished.\n");

  const resolved = [];
  while (resolved.length < 6) {
    const input = (await ask(`  Enemy ${resolved.length + 1}: `)).trim();
    if (!input || input.toLowerCase() === "done") break;

    // Allow comma-separated input
    const parts = input.split(",").map((s) => s.trim()).filter(Boolean);
    for (const part of parts) {
      const hero = findHero(part, heroList);
      if (!hero) {
        console.log(`  ✗ "${part}" not found. Try again.`);
      } else {
        resolved.push(hero);
        console.log(`  ✓ ${capitalize(hero.name)}`);
      }
    }
  }

  rl.close();
  return resolved;
}

// ─── Main ──────────────────────────────────────────────────────────────────
(async () => {
  let db;
  try {
    db = await openDb(DB_PATH);

    // Load hero list from DB (populated by sync script)
    const heroList = await all(db, `SELECT hero_id, name, role FROM heroes ORDER BY name;`);
    if (heroList.length === 0) {
      throw new Error("No heroes in DB. Run sync_marvelrivals.js first.");
    }

    const enemyHeroes = await getEnemyHeroes(heroList);
    if (enemyHeroes.length === 0) {
      console.log("No enemy heroes entered. Exiting.");
      process.exit(0);
    }

    const enemyHeroIds = enemyHeroes.map((h) => h.hero_id);
    const enemyNames   = enemyHeroes.map((h) => h.name);

    const { results, globalWR } = await computeScores(db, enemyHeroIds);
    printRecommendations(results, enemyNames, globalWR, heroList);

  } catch (e) {
    console.error("\nERROR:", e.message);
  } finally {
    if (db) db.close();
  }
})();