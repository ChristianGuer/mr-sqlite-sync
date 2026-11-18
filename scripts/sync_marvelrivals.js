// sync_marvelrivals.js
// Built against actual MarvelRivalsAPI.com response shapes (v2 history + v1 match details)
// Goal: store full match + all 12 players so we can later recommend hero picks vs enemy comp
//
// Setup:
//   npm install sqlite3 dotenv
//   Create a .env file with:
//     MR_API_KEY=your_key_here
//     MR_USERNAME=your_username
//     MR_PAGES=3          (how many pages of history to fetch, 40 matches per page)
//
// Run:
//   node sync_marvelrivals.js

require("dotenv").config();
const sqlite3 = require("sqlite3").verbose();

// ─── Config ────────────────────────────────────────────────────────────────
const API_KEY  = process.env.MR_API_KEY;
const USERNAME = process.env.MR_USERNAME;
const DB_PATH  = process.env.MR_DB_PATH || "./marvelrivals.db";
const PAGES    = Number(process.env.MR_PAGES  || 1);
const LIMIT    = Number(process.env.MR_LIMIT  || 40);
const DELAY_MS = Number(process.env.MR_DELAY  || 300); // ms between match-detail calls

if (!API_KEY)  throw new Error("MR_API_KEY is missing from .env");
if (!USERNAME) throw new Error("MR_USERNAME is missing from .env");

const BASE = "https://marvelrivalsapi.com";

// ─── DB helpers ────────────────────────────────────────────────────────────
const openDb = (path) => new sqlite3.Database(path);

const run = (db, sql, params = []) =>
  new Promise((res, rej) =>
    db.run(sql, params, function (err) { err ? rej(err) : res(this); })
  );

const all = (db, sql, params = []) =>
  new Promise((res, rej) =>
    db.all(sql, params, (err, rows) => (err ? rej(err) : res(rows)))
  );

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ─── API helper ────────────────────────────────────────────────────────────
async function apiGet(path) {
  const url = `${BASE}${path}`;
  const res = await fetch(url, {
    headers: { "x-api-key": API_KEY, accept: "application/json" },
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`${res.status} ${res.statusText} — ${path}\n${text}`);
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`Non-JSON from ${path}: ${text.slice(0, 200)}`);
  }
}

// ─── Hero lookup ───────────────────────────────────────────────────────────
// Hardcoded full roster — no longer relies on the API's /v1/heroes endpoint
// which may lag behind or stop being updated.
//
// IDs in the 1000s are the real IDs confirmed from the API.
// IDs in the 1055+ range are sequential placeholders for heroes the API never
// returned — if the API eventually starts returning them, sync will reconcile
// automatically via ON CONFLICT DO UPDATE on hero_id.
//
// To add a future hero: append to HERO_ROSTER below and re-run sync.
const HERO_ROSTER = [
  // ── Launch roster (Season 0) ──────────────────────────────────────────
  { hero_id: 1011, name: "hulk",                role: "Vanguard"   },
  { hero_id: 1014, name: "the punisher",         role: "Duelist"    },
  { hero_id: 1015, name: "storm",                role: "Duelist"    },
  { hero_id: 1016, name: "loki",                 role: "Strategist" },
  { hero_id: 1017, name: "human torch",          role: "Duelist"    },
  { hero_id: 1018, name: "doctor strange",       role: "Vanguard"   },
  { hero_id: 1020, name: "mantis",               role: "Strategist" },
  { hero_id: 1021, name: "hawkeye",              role: "Duelist"    },
  { hero_id: 1022, name: "captain america",      role: "Vanguard"   },
  { hero_id: 1023, name: "rocket raccoon",       role: "Strategist" },
  { hero_id: 1024, name: "hela",                 role: "Duelist"    },
  { hero_id: 1025, name: "cloak & dagger",       role: "Strategist" },
  { hero_id: 1026, name: "black panther",        role: "Duelist"    },
  { hero_id: 1027, name: "groot",                role: "Vanguard"   },
  { hero_id: 1029, name: "magik",                role: "Duelist"    },
  { hero_id: 1030, name: "moon knight",          role: "Duelist"    },
  { hero_id: 1031, name: "luna snow",            role: "Strategist" },
  { hero_id: 1032, name: "squirrel girl",        role: "Duelist"    },
  { hero_id: 1033, name: "black widow",          role: "Duelist"    },
  { hero_id: 1034, name: "iron man",             role: "Duelist"    },
  { hero_id: 1035, name: "venom",                role: "Vanguard"   },
  { hero_id: 1036, name: "spider-man",           role: "Duelist"    },
  { hero_id: 1037, name: "magneto",              role: "Vanguard"   },
  { hero_id: 1038, name: "scarlet witch",        role: "Duelist"    },
  { hero_id: 1039, name: "thor",                 role: "Vanguard"   },
  { hero_id: 1040, name: "mister fantastic",     role: "Duelist"    },
  { hero_id: 1041, name: "winter soldier",       role: "Duelist"    },
  { hero_id: 1042, name: "peni parker",          role: "Vanguard"   },
  { hero_id: 1043, name: "star-lord",            role: "Duelist"    },
  { hero_id: 1045, name: "namor",                role: "Duelist"    },
  { hero_id: 1046, name: "adam warlock",         role: "Strategist" },
  { hero_id: 1047, name: "jeff the land shark",  role: "Strategist" },
  { hero_id: 1048, name: "psylocke",             role: "Duelist"    },
  { hero_id: 1049, name: "wolverine",            role: "Duelist"    },
  // ── Season 1 ──────────────────────────────────────────────────────────
  { hero_id: 1050, name: "invisible woman",      role: "Strategist" },
  { hero_id: 1051, name: "the thing",            role: "Vanguard"   },
  { hero_id: 1052, name: "iron fist",            role: "Duelist"    },
  // ── Season 2 ──────────────────────────────────────────────────────────
  { hero_id: 1053, name: "emma frost",           role: "Vanguard"   },
  { hero_id: 1054, name: "phoenix",              role: "Duelist"    },
  { hero_id: 1028, name: "ultron",               role: "Strategist" },
  // ── Season 3+ (API stopped returning these) ───────────────────────────
  { hero_id: 1055, name: "blade",                role: "Duelist"    },
  { hero_id: 1057, name: "daredevil",            role: "Duelist"    },
  { hero_id: 1058, name: "black cat",            role: "Duelist"    },
  { hero_id: 1059, name: "gambit",               role: "Duelist"    },
  { hero_id: 1060, name: "rogue",                role: "Vanguard"   },
  { hero_id: 1061, name: "angela",               role: "Vanguard"   },
  { hero_id: 1062, name: "elsa bloodstone",      role: "Duelist"    },
  { hero_id: 1063, name: "white fox",            role: "Strategist" },
  { hero_id: 1064, name: "deadpool",             role: "Duelist"    }, // multi-role; primary listed as Duelist
];

async function loadHeroes(db) {
  const heroMap = new Map();

  // Deduplicate by hero_id (last entry wins) before writing to DB
  const deduped = new Map();
  for (const h of HERO_ROSTER) deduped.set(h.hero_id, h);

  for (const h of deduped.values()) {
    heroMap.set(h.hero_id, h.name);
    heroMap.set(String(h.hero_id), h.name);

    await run(db, `
      INSERT INTO heroes (hero_id, name, role, image_url)
      VALUES (?, ?, ?, NULL)
      ON CONFLICT(hero_id) DO UPDATE SET
        name = excluded.name,
        role = excluded.role;
    `, [h.hero_id, h.name, h.role]);
  }

  console.log(`  Hero roster loaded: ${deduped.size} heroes (hardcoded)`);
  return heroMap;
}

// ─── Schema ────────────────────────────────────────────────────────────────
// Three tables:
//   matches       — one row per match, includes which camp YOU were on
//   match_players — one row per player per match (all 12 players)
//   player_heroes — one row per hero segment per player (if someone swapped heroes mid-match)
//
// The key column for the recommendation algorithm:
//   match_players.camp       — 0 or 1, which team this player was on
//   matches.my_camp          — which camp YOU were on (so we can identify enemies)
//   match_players.cur_hero_id / cur_hero_name — the hero they ended the match on
//
async function initSchema(db) {
  await run(db, "PRAGMA foreign_keys = ON;");
  await run(db, "PRAGMA journal_mode = WAL;"); // faster concurrent writes

  await run(db, `
    CREATE TABLE IF NOT EXISTS heroes (
      hero_id   INTEGER PRIMARY KEY,
      name      TEXT NOT NULL,
      role      TEXT,
      image_url TEXT
    );
  `);

  await run(db, `
    CREATE TABLE IF NOT EXISTS matches (
      match_uid           TEXT PRIMARY KEY,
      match_time_stamp    INTEGER,
      match_season        TEXT,
      match_map_id        INTEGER,
      match_play_duration TEXT,
      match_winner_side   INTEGER,
      play_mode_id        INTEGER,
      game_mode_id        INTEGER,
      game_mode_name      TEXT,
      my_camp             INTEGER,   -- which camp YOU (MR_USERNAME) were on (0 or 1)
      my_is_win           INTEGER,   -- 1 = you won, 0 = you lost
      mvp_uid             TEXT,
      svp_uid             TEXT,
      replay_id           TEXT,
      fetched_at          INTEGER NOT NULL DEFAULT (strftime('%s','now'))
    );
  `);

  await run(db, `
    CREATE TABLE IF NOT EXISTS match_players (
      match_uid          TEXT    NOT NULL,
      player_uid         TEXT    NOT NULL,
      nick_name          TEXT,
      camp               INTEGER,           -- 0 or 1 — compare to matches.my_camp to find enemies
      is_win             INTEGER,           -- 1 = won, 0 = lost
      is_me              INTEGER DEFAULT 0, -- 1 if this row is MR_USERNAME
      cur_hero_id        INTEGER,
      cur_hero_name      TEXT,
      cur_hero_icon      TEXT,
      kills              INTEGER,
      deaths             INTEGER,
      assists            INTEGER,
      total_hero_damage  REAL,
      total_hero_heal    REAL,
      total_damage_taken REAL,
      disconnected       INTEGER,
      PRIMARY KEY (match_uid, player_uid),
      FOREIGN KEY (match_uid) REFERENCES matches(match_uid) ON DELETE CASCADE
    );
  `);

  await run(db, `
    CREATE TABLE IF NOT EXISTS player_heroes (
      match_uid        TEXT    NOT NULL,
      player_uid       TEXT    NOT NULL,
      hero_id          INTEGER NOT NULL,
      hero_name        TEXT,
      hero_icon        TEXT,
      play_time_secs   REAL,
      kills            INTEGER,
      deaths           INTEGER,
      assists          INTEGER,
      session_hit_rate REAL,
      PRIMARY KEY (match_uid, player_uid, hero_id),
      FOREIGN KEY (match_uid) REFERENCES matches(match_uid) ON DELETE CASCADE
    );
  `);

  // Indexes useful for the recommendation queries
  await run(db, `CREATE INDEX IF NOT EXISTS idx_mp_player  ON match_players(player_uid);`);
  await run(db, `CREATE INDEX IF NOT EXISTS idx_mp_hero    ON match_players(cur_hero_id);`);
  await run(db, `CREATE INDEX IF NOT EXISTS idx_mp_camp    ON match_players(match_uid, camp);`);
  await run(db, `CREATE INDEX IF NOT EXISTS idx_ph_player  ON player_heroes(player_uid);`);
  await run(db, `CREATE INDEX IF NOT EXISTS idx_m_time     ON matches(match_time_stamp);`);
}

// ─── Upsert helpers ────────────────────────────────────────────────────────

async function upsertMatch(db, row) {
  await run(db, `
    INSERT INTO matches (
      match_uid, match_time_stamp, match_season, match_map_id, match_play_duration,
      match_winner_side, play_mode_id, game_mode_id, game_mode_name,
      my_camp, my_is_win, mvp_uid, svp_uid, replay_id
    ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)
    ON CONFLICT(match_uid) DO UPDATE SET
      match_time_stamp    = COALESCE(excluded.match_time_stamp,    matches.match_time_stamp),
      match_season        = COALESCE(excluded.match_season,        matches.match_season),
      match_map_id        = COALESCE(excluded.match_map_id,        matches.match_map_id),
      match_play_duration = COALESCE(excluded.match_play_duration, matches.match_play_duration),
      match_winner_side   = COALESCE(excluded.match_winner_side,   matches.match_winner_side),
      play_mode_id        = COALESCE(excluded.play_mode_id,        matches.play_mode_id),
      game_mode_id        = COALESCE(excluded.game_mode_id,        matches.game_mode_id),
      game_mode_name      = COALESCE(excluded.game_mode_name,      matches.game_mode_name),
      my_camp             = COALESCE(excluded.my_camp,             matches.my_camp),
      my_is_win           = COALESCE(excluded.my_is_win,           matches.my_is_win),
      mvp_uid             = COALESCE(excluded.mvp_uid,             matches.mvp_uid),
      svp_uid             = COALESCE(excluded.svp_uid,             matches.svp_uid),
      replay_id           = COALESCE(excluded.replay_id,           matches.replay_id),
      fetched_at          = strftime('%s','now');
  `, [
    row.match_uid,
    row.match_time_stamp    ?? null,
    row.match_season        ?? null,
    row.match_map_id        ?? null,
    row.match_play_duration ?? null,
    row.match_winner_side   ?? null,
    row.play_mode_id        ?? null,
    row.game_mode_id        ?? null,
    row.game_mode_name      ?? null,
    row.my_camp             ?? null,
    row.my_is_win           ?? null,
    row.mvp_uid             ?? null,
    row.svp_uid             ?? null,
    row.replay_id           ?? null,
  ]);
}

async function upsertPlayer(db, match_uid, p, isMe) {
  // is_win: the v1 details response gives is_win as 0/1 directly on the player
  await run(db, `
    INSERT INTO match_players (
      match_uid, player_uid, nick_name, camp, is_win, is_me,
      cur_hero_id, cur_hero_name, cur_hero_icon,
      kills, deaths, assists,
      total_hero_damage, total_hero_heal, total_damage_taken, disconnected
    ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
    ON CONFLICT(match_uid, player_uid) DO UPDATE SET
      nick_name          = excluded.nick_name,
      camp               = excluded.camp,
      is_win             = excluded.is_win,
      is_me              = excluded.is_me,
      cur_hero_id        = excluded.cur_hero_id,
      cur_hero_name      = excluded.cur_hero_name,
      cur_hero_icon      = excluded.cur_hero_icon,
      kills              = excluded.kills,
      deaths             = excluded.deaths,
      assists            = excluded.assists,
      total_hero_damage  = excluded.total_hero_damage,
      total_hero_heal    = excluded.total_hero_heal,
      total_damage_taken = excluded.total_damage_taken,
      disconnected       = excluded.disconnected;
  `, [
    match_uid,
    String(p.player_uid),
    p.nick_name          ?? null,
    p.camp               ?? null,
    p.is_win             ?? null,
    isMe ? 1 : 0,
    p.cur_hero_id        ?? null,
    p.cur_hero_name      ?? null,
    p.cur_hero_icon      ?? null,
    p.kills              ?? null,
    p.deaths             ?? null,
    p.assists            ?? null,
    p.total_hero_damage  ?? null,
    p.total_hero_heal    ?? null,
    p.total_damage_taken ?? null,
    p.disconnected ? 1 : 0,
  ]);
}

async function upsertHeroSegments(db, match_uid, player_uid, heroes, heroMap = new Map()) {
  if (!Array.isArray(heroes) || heroes.length === 0) return;
  for (const h of heroes) {
    // play_time can be { raw, formatted } (v2) or a plain number (v1)
    const playSecs = typeof h.play_time === "object" ? h.play_time?.raw : h.play_time;
    await run(db, `
      INSERT INTO player_heroes (
        match_uid, player_uid, hero_id, hero_name, hero_icon,
        play_time_secs, kills, deaths, assists, session_hit_rate
      ) VALUES (?,?,?,?,?,?,?,?,?,?)
      ON CONFLICT(match_uid, player_uid, hero_id) DO UPDATE SET
        hero_name        = excluded.hero_name,
        hero_icon        = excluded.hero_icon,
        play_time_secs   = excluded.play_time_secs,
        kills            = excluded.kills,
        deaths           = excluded.deaths,
        assists          = excluded.assists,
        session_hit_rate = excluded.session_hit_rate;
    `, [
      match_uid,
      String(player_uid),
      h.hero_id          ?? null,
      h.hero_name ?? heroMap.get(h.hero_id) ?? null,
      h.hero_icon ?? h.hero_thumbnail ?? null,
      playSecs           ?? null,
      h.kills            ?? null,
      h.deaths           ?? null,
      h.assists          ?? null,
      h.session_hit_rate ?? null,
    ]);
  }
}

// ─── Step 1: Fetch match history (v2) ─────────────────────────────────────
// The v2 endpoint returns YOUR player row + hero info for each match.
// We use this to build the list of match_uids to fetch details for.
// We also store your player row here immediately from the v2 data.
async function fetchMatchHistory(db, heroMap) {
  console.log(`\n[1/2] Fetching match history for "${USERNAME}" (${PAGES} page(s), ${LIMIT}/page)...`);

  const matchMap = new Map(); // match_uid -> history row

  for (let page = 1; page <= PAGES; page++) {
    const data = await apiGet(
      `/api/v2/player/${encodeURIComponent(USERNAME)}/match-history?page=${page}&limit=${LIMIT}`
    );

    const items = data.match_history;
    if (!Array.isArray(items) || items.length === 0) {
      console.log(`  Page ${page}: no results, stopping early.`);
      break;
    }

    console.log(`  Page ${page}: ${items.length} matches`);

    for (const item of items) {
      if (!item.match_uid) continue;
      matchMap.set(item.match_uid, item);
    }

    // Stop early if no more pages
    if (data.pagination && !data.pagination.has_more) break;
  }

  console.log(`  Total unique matches from history: ${matchMap.size}`);

  // Store basic match row + your player row from v2 data
  // (will be enriched with full player list in step 2)
  for (const [match_uid, item] of matchMap) {
    const mp = item.match_player; // YOUR player data from v2
    const ph = mp?.player_hero;   // YOUR hero data from v2

    // Determine is_win — v2 wraps it: { score, is_win }
    const isWin = typeof mp?.is_win === "object" ? (mp.is_win?.is_win ? 1 : 0) : (mp?.is_win ? 1 : 0);

    await upsertMatch(db, {
      match_uid,
      match_time_stamp:    item.match_time_stamp    ?? null,
      match_season:        String(item.match_season ?? ""),
      match_map_id:        item.match_map_id        ?? null,
      match_play_duration: item.match_play_duration ?? null,
      match_winner_side:   item.match_winner_side   ?? null,
      play_mode_id:        item.play_mode_id        ?? null,
      game_mode_id:        item.game_mode_id        ?? null,
      game_mode_name:      null,       // filled in step 2 from v1 details
      my_camp:             mp?.camp    ?? null,
      my_is_win:           isWin,
      mvp_uid:             String(item.mvp_uid ?? ""),
      svp_uid:             String(item.svp_uid ?? ""),
      replay_id:           null,       // filled in step 2
    });

    // Store your own player row from v2 data immediately
    if (mp) {
      await upsertPlayer(db, match_uid, {
        player_uid:         mp.player_uid,
        nick_name:          USERNAME,
        camp:               mp.camp             ?? null,
        is_win:             isWin,
        disconnected:       mp.disconnected      ?? false,
        cur_hero_id:        ph?.hero_id          ?? null,
        cur_hero_name:      ph?.hero_name ?? heroMap.get(ph?.hero_id) ?? null,
        cur_hero_icon:      ph?.hero_type ?? ph?.hero_thumbnail ?? null,
        kills:              mp.kills             ?? null,
        deaths:             mp.deaths            ?? null,
        assists:            mp.assists           ?? null,
        total_hero_damage:  ph?.total_hero_damage  ?? null,
        total_hero_heal:    ph?.total_hero_heal    ?? null,
        total_damage_taken: ph?.total_damage_taken ?? null,
      }, true); // isMe = true

      // Store your hero segment too
      if (ph) {
        await upsertHeroSegments(db, match_uid, mp.player_uid, [ph]);
      }
    }
  }

  return [...matchMap.keys()];
}

// ─── Step 2: Fetch full match details (v1) — gets all 12 players ───────────
// This is the critical step for the recommendation algorithm.
// /api/v1/match/{match_uid} returns match_details.match_players — all players in the lobby.
async function fetchMatchDetails(db, matchUids, heroMap) {
  console.log(`\n[2/2] Fetching full match details for ${matchUids.length} matches...`);
  console.log(`      (${DELAY_MS}ms delay between calls to respect rate limits)\n`);

  let ok = 0;
  let failed = 0;

  for (let i = 0; i < matchUids.length; i++) {
    const match_uid = matchUids[i];
    const label = `[${i + 1}/${matchUids.length}]`;

    try {
      const data = await apiGet(`/api/v1/match/${encodeURIComponent(match_uid)}`);
      const md = data.match_details;

      if (!md) throw new Error("Response missing match_details");

      // Enrich match row with v1-only fields
      await upsertMatch(db, {
        match_uid:     md.match_uid ?? match_uid,
        game_mode_id:  md.game_mode?.game_mode_id   ?? null,
        game_mode_name:md.game_mode?.game_mode_name ?? null,
        replay_id:     md.replay_id ?? null,
        mvp_uid:       String(md.mvp_uid ?? ""),
        svp_uid:       String(md.svp_uid ?? ""),
      });

      // The v1 response nests players under match_dynamic_fields.match_players
      // OR sometimes directly under match_players depending on API version
      const players =
        md.match_dynamic_fields?.match_players ??
        md.match_players ??
        [];

      if (players.length === 0) {
        console.warn(`${label} WARNING: No players found in match ${match_uid}`);
      }

      // We need to know MY player_uid to mark is_me correctly.
      // We already stored it in match_players from step 1 — look it up.
      const myRow = await all(db,
        `SELECT player_uid FROM match_players WHERE match_uid = ? AND is_me = 1 LIMIT 1`,
        [match_uid]
      );
      const myUid = myRow[0]?.player_uid ?? null;

      for (const p of players) {
        const uid = String(p.player_uid);
        const isMe = myUid && uid === String(myUid);

        // Normalize is_win — v1 gives it as 0/1 on the player object directly
        const isWin = p.is_win === true || p.is_win === 1 ? 1 : (p.is_win === false || p.is_win === 0 ? 0 : null);

        await upsertPlayer(db, match_uid, {
          player_uid:         uid,
          nick_name:          p.nick_name         ?? null,
          camp:               p.camp              ?? null,
          is_win:             isWin,
          disconnected:       p.disconnected       ?? false,
          cur_hero_id:        p.cur_hero_id        ?? null,
          cur_hero_name:      p.cur_hero_name ?? heroMap.get(p.cur_hero_id) ?? null,
          cur_hero_icon:      p.cur_hero_icon      ?? null,
          kills:              p.kills              ?? null,
          deaths:             p.deaths             ?? null,
          assists:            p.assists            ?? null,
          total_hero_damage:  p.total_hero_damage  ?? null,
          total_hero_heal:    p.total_hero_heal    ?? null,
          total_damage_taken: p.total_damage_taken ?? null,
        }, isMe);

        // Hero segments — stored under p.player_heroes in v1
        await upsertHeroSegments(db, match_uid, uid, p.player_heroes ?? [], heroMap);
      }

      ok++;
      console.log(`${label} ✓ ${match_uid}  (${players.length} players stored)`);
    } catch (e) {
      failed++;
      console.log(`${label} ✗ ${match_uid}: ${e.message}`);
    }

    if (i < matchUids.length - 1) await sleep(DELAY_MS);
  }

  return { ok, failed };
}

// ─── Summary ───────────────────────────────────────────────────────────────
async function printSummary(db) {
  console.log("\n═══════════════════════════════════");
  console.log("  SUMMARY");
  console.log("═══════════════════════════════════");

  const [matchRow]  = await all(db, `SELECT COUNT(*) AS c FROM matches;`);
  const [playerRow] = await all(db, `SELECT COUNT(*) AS c FROM match_players;`);
  const [heroRow]   = await all(db, `SELECT COUNT(*) AS c FROM player_heroes;`);

  console.log(`Matches stored:       ${matchRow.c}`);
  console.log(`Player rows stored:   ${playerRow.c}`);
  console.log(`Hero segments stored: ${heroRow.c}`);

  // Your W/L
  const [wl] = await all(db, `
    SELECT
      SUM(CASE WHEN is_win = 1 THEN 1 ELSE 0 END) AS wins,
      SUM(CASE WHEN is_win = 0 THEN 1 ELSE 0 END) AS losses
    FROM match_players WHERE is_me = 1;
  `);
  if (wl) {
    const total = (wl.wins || 0) + (wl.losses || 0);
    const pct   = total > 0 ? ((wl.wins / total) * 100).toFixed(1) : "0.0";
    console.log(`\nYour record: ${wl.wins}W / ${wl.losses}L (${pct}% WR)`);
  }

  // Your most played heroes
  const heroes = await all(db, `
    SELECT
      ph.hero_name,
      ph.hero_id,
      COUNT(DISTINCT ph.match_uid)  AS games,
      SUM(ph.kills)                 AS kills,
      SUM(ph.deaths)                AS deaths,
      SUM(ph.assists)               AS assists,
      ROUND(SUM(ph.play_time_secs) / 60.0, 1) AS total_mins
    FROM player_heroes ph
    JOIN match_players mp ON mp.match_uid = ph.match_uid AND mp.player_uid = ph.player_uid
    WHERE mp.is_me = 1
    GROUP BY ph.hero_id
    ORDER BY games DESC
    LIMIT 8;
  `);

  if (heroes.length > 0) {
    console.log("\nYour most played heroes:");
    for (const h of heroes) {
      const name = h.hero_name || `hero_id:${h.hero_id}`;
      console.log(`  ${name.padEnd(28)} ${String(h.games).padStart(3)} games  ${h.kills}/${h.deaths}/${h.assists}  ${h.total_mins}min`);
    }
  }

  console.log("\n✓ Database ready for analysis at:", DB_PATH);
}

// ─── Main ──────────────────────────────────────────────────────────────────
(async () => {
  const db = openDb(DB_PATH);

  try {
    console.log("Marvel Rivals sync starting...");
    console.log(`User: ${USERNAME} | DB: ${DB_PATH} | Pages: ${PAGES} | Limit: ${LIMIT}`);

    await initSchema(db);

    console.log("\n[0/2] Fetching hero list for name lookups...");
    const heroMap = await loadHeroes(db);

    const matchUids = await fetchMatchHistory(db, heroMap);
    const { ok, failed } = await fetchMatchDetails(db, matchUids, heroMap);

    console.log(`\nDetail fetch complete: ${ok} OK, ${failed} failed`);
    await printSummary(db);
  } catch (e) {
    console.error("\nFATAL:", e);
  } finally {
    db.close();
  }
})();