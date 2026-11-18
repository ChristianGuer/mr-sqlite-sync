const sqlite3 = require("sqlite3").verbose();

const BAYES_C = 5;
const TOP_N = 5;

const openDb = (path) =>
  new Promise((res, rej) => {
    const db = new sqlite3.Database(path, (err) => (err ? rej(err) : res(db)));
  });

const all = (db, sql, params = []) =>
  new Promise((res, rej) =>
    db.all(sql, params, (err, rows) => (err ? rej(err) : res(rows)))
  );

function bayesian(wins, games, prior, C) {
  return (wins + C * prior) / (games + C);
}

async function computeScores(db, enemyHeroIds) {
  const [globalRow] = await all(db, `
    SELECT SUM(is_win) * 1.0 / COUNT(*) AS global_wr
    FROM match_players
    WHERE is_me = 1 AND is_win IS NOT NULL;
  `);
  const globalWR = globalRow?.global_wr ?? 0.5;

  const heroStats = await all(db, `
    SELECT
      mp.cur_hero_id                   AS hero_id,
      mp.cur_hero_name                 AS hero_name,
      COUNT(*)                         AS games,
      SUM(mp.is_win)                   AS wins,
      SUM(mp.is_win) * 1.0 / COUNT(*) AS raw_wr
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

  const matchupRows = await all(db, `
    SELECT
      mp_me.cur_hero_id     AS my_hero_id,
      mp_enemy.cur_hero_id  AS enemy_hero_id,
      COUNT(*)              AS games,
      SUM(mp_me.is_win)     AS wins
    FROM match_players mp_me
    JOIN match_players mp_enemy
      ON  mp_enemy.match_uid = mp_me.match_uid
      AND mp_enemy.camp      != mp_me.camp
    WHERE mp_me.is_me = 1
      AND mp_me.is_win IS NOT NULL
      AND mp_me.cur_hero_id IS NOT NULL
      AND mp_enemy.cur_hero_id IN (${enemyHeroIds.map(() => "?").join(",")})
    GROUP BY mp_me.cur_hero_id, mp_enemy.cur_hero_id;
  `, enemyHeroIds);

  const matchupIndex = {};
  for (const row of matchupRows) {
    matchupIndex[`${row.my_hero_id}:${row.enemy_hero_id}`] = row;
  }

  const results = [];
  for (const hs of heroStats) {
    const baselineScore = bayesian(hs.wins, hs.games, globalWR, BAYES_C);
    const counterSignals = [];
    let totalMatchupGames = 0;

    for (const enemyId of enemyHeroIds) {
      const mu = matchupIndex[`${hs.hero_id}:${enemyId}`];
      if (mu && mu.games > 0) {
        counterSignals.push({ signal: bayesian(mu.wins, mu.games, globalWR, BAYES_C), games: mu.games });
        totalMatchupGames += mu.games;
      } else {
        counterSignals.push({ signal: baselineScore, games: 0 });
      }
    }

    const avgCounterSignal =
      counterSignals.reduce((sum, s) => sum + s.signal, 0) / counterSignals.length;

    const counterWeight = Math.min(
      totalMatchupGames / (totalMatchupGames + BAYES_C * enemyHeroIds.length),
      0.8
    );
    const finalScore = (1 - counterWeight) * baselineScore + counterWeight * avgCounterSignal;

    results.push({
      hero_id:       hs.hero_id,
      hero_name:     hs.hero_name ?? `hero_id:${hs.hero_id}`,
      score:         Math.round(finalScore * 100),
      games:         hs.games,
      wins:          hs.wins,
      personal_wr:   Math.round((hs.raw_wr ?? 0) * 100),
      matchup_games: totalMatchupGames,
      low_data:      totalMatchupGames < 10,
    });
  }

  results.sort((a, b) => b.score - a.score);
  return { results: results.slice(0, TOP_N), globalWR };
}

module.exports = { openDb, all, bayesian, computeScores, BAYES_C, TOP_N };
