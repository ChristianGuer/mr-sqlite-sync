// sync_manual.js
// Fetches and stores match details for specific match IDs you provide manually.
// Use this when the match history API is broken but you have match IDs from the game.
//
// Usage:
//   node scripts/sync_manual.js --file matches.txt
//   node scripts/sync_manual.js MATCH_ID_1 MATCH_ID_2 MATCH_ID_3 ...
//
// Text file format — one match ID per line, blank lines and # comments ignored:
//   ABC123
//   DEF456
//   # this is a comment
//   GHI789

require("dotenv").config();
const sqlite3 = require("sqlite3").verbose();
const fs = require("fs");

const API_KEY  = process.env.MR_API_KEY;
const USERNAME = process.env.MR_USERNAME;
const DB_PATH  = process.env.MR_DB_PATH || "./marvelrivals.db";
const DELAY_MS = Number(process.env.MR_DELAY || 300);
const BASE     = "https://marvelrivalsapi.com";

if (!API_KEY)  throw new Error("MR_API_KEY is missing from .env");
if (!USERNAME) throw new Error("MR_USERNAME is missing from .env");

const args = process.argv.slice(2);
let matchIds = [];

if (args[0] === "--file") {
  const filePath = args[1];
  if (!filePath) {
    console.error("Usage: node scripts/sync_manual.js --file matches.txt");
    process.exit(1);
  }
  if (!fs.existsSync(filePath)) {
    console.error(`File not found: ${filePath}`);
    process.exit(1);
  }
  matchIds = fs.readFileSync(filePath, "utf8")
    .split("\n")
    .map(l => l.trim())
    .filter(l => l && !l.startsWith("#"));
} else {
  matchIds = args;
}

if (matchIds.length === 0) {
  console.error("No match IDs provided.");
  console.error("  From file: node scripts/sync_manual.js --file matches.txt");
  console.error("  Inline:    node scripts/sync_manual.js ID1 ID2 ID3");
  process.exit(1);
}

// ─── DB helpers ──────────────────────────────────────────────────────────────
const openDb = (path) => new sqlite3.Database(path);

const run = (db, sql, params = []) =>
  new Promise((res, rej) =>
    db.run(sql, params, function (err) { err ? rej(err) : res(this); })
  );

const all = (db, sql, params = []) =>
  new Promise((res, rej) =>
    db.all(sql, params, (err, rows) => (err ? rej(err) : res(rows)))
  );

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

// ─── API helper ──────────────────────────────────────────────────────────────
async function apiGet(path) {
  const res = await fetch(`${BASE}${path}`, {
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

// ─── Upsert helpers (same as sync_marvelrivals.js) ───────────────────────────
async function upsertMatch(db, row) {
  await run(db, `
    INSERT INTO matches (
      match_uid, match_time_stamp, match_season, match_map_id, match_play_duration,
      match_winner_side, play_mode_id, game_mode_id, game_mode_name,
      my_camp, my_is_win, mvp_uid, svp_uid, replay_id
    ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)
    ON CONFLICT(match_uid) DO UPDATE SET
      match_time_stamp    = COALESCE(excluded.match_time_stamp,    matches.match_time_stamp),
      game_mode_id        = COALESCE(excluded.game_mode_id,        matches.game_mode_id),
      game_mode_name      = COALESCE(excluded.game_mode_name,      matches.game_mode_name),
      my_camp             = COALESCE(excluded.my_camp,             matches.my_camp),
      my_is_win           = COALESCE(excluded.my_is_win,           matches.my_is_win),
      mvp_uid             = COALESCE(excluded.mvp_uid,             matches.mvp_uid),
      svp_uid             = COALESCE(excluded.svp_uid,             matches.svp_uid),
      replay_id           = COALESCE(excluded.replay_id,           matches.replay_id),
      fetched_at          = strftime('%s','now');
  `, [
    row.match_uid, row.match_time_stamp ?? null, row.match_season ?? null,
    row.match_map_id ?? null, row.match_play_duration ?? null,
    row.match_winner_side ?? null, row.play_mode_id ?? null,
    row.game_mode_id ?? null, row.game_mode_name ?? null,
    row.my_camp ?? null, row.my_is_win ?? null,
    String(row.mvp_uid ?? ""), String(row.svp_uid ?? ""), row.replay_id ?? null,
  ]);
}

async function upsertPlayer(db, match_uid, p, isMe) {
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
    match_uid, String(p.player_uid), p.nick_name ?? null, p.camp ?? null,
    p.is_win ?? null, isMe ? 1 : 0,
    p.cur_hero_id ?? null, p.cur_hero_name ?? null, p.cur_hero_icon ?? null,
    p.kills ?? null, p.deaths ?? null, p.assists ?? null,
    p.total_hero_damage ?? null, p.total_hero_heal ?? null,
    p.total_damage_taken ?? null, p.disconnected ? 1 : 0,
  ]);
}

async function upsertHeroSegments(db, match_uid, player_uid, heroes) {
  if (!Array.isArray(heroes) || heroes.length === 0) return;
  for (const h of heroes) {
    const playSecs = typeof h.play_time === "object" ? h.play_time?.raw : h.play_time;
    await run(db, `
      INSERT INTO player_heroes (
        match_uid, player_uid, hero_id, hero_name, hero_icon,
        play_time_secs, kills, deaths, assists, session_hit_rate
      ) VALUES (?,?,?,?,?,?,?,?,?,?)
      ON CONFLICT(match_uid, player_uid, hero_id) DO UPDATE SET
        hero_name        = excluded.hero_name,
        play_time_secs   = excluded.play_time_secs,
        kills            = excluded.kills,
        deaths           = excluded.deaths,
        assists          = excluded.assists,
        session_hit_rate = excluded.session_hit_rate;
    `, [
      match_uid, String(player_uid), h.hero_id ?? null,
      h.hero_name ?? null, h.hero_icon ?? h.hero_thumbnail ?? null,
      playSecs ?? null, h.kills ?? null, h.deaths ?? null,
      h.assists ?? null, h.session_hit_rate ?? null,
    ]);
  }
}

// ─── Main ────────────────────────────────────────────────────────────────────
(async () => {
  const db = openDb(DB_PATH);
  let ok = 0;
  let failed = 0;
  let skipped = 0;

  console.log(`\nFetching ${matchIds.length} match(es) manually...\n`);

  for (let i = 0; i < matchIds.length; i++) {
    const match_uid = matchIds[i];
    const label = `[${i + 1}/${matchIds.length}]`;

    // Skip if already in DB
    const existing = await all(db, `SELECT match_uid FROM matches WHERE match_uid = ?`, [match_uid]);
    if (existing.length > 0) {
      console.log(`${label} SKIP ${match_uid} (already stored)`);
      skipped++;
      continue;
    }

    try {
      const data = await apiGet(`/api/v1/match/${encodeURIComponent(match_uid)}`);
      const md = data.match_details;
      if (!md) throw new Error("Response missing match_details");

      await upsertMatch(db, {
        match_uid:          md.match_uid ?? match_uid,
        game_mode_id:       md.game_mode?.game_mode_id   ?? null,
        game_mode_name:     md.game_mode?.game_mode_name ?? null,
        match_winner_side:  md.match_winner_side         ?? null,
        replay_id:          md.replay_id                 ?? null,
        mvp_uid:            md.mvp_uid                   ?? null,
        svp_uid:            md.svp_uid                   ?? null,
      });

      const players =
        md.match_dynamic_fields?.match_players ??
        md.match_players ??
        [];

      // Find which player is you by matching username
      const myPlayer = players.find(p =>
        p.nick_name?.toLowerCase() === USERNAME.toLowerCase()
      );
      const myUid = myPlayer ? String(myPlayer.player_uid) : null;

      for (const p of players) {
        const uid = String(p.player_uid);
        const isMe = myUid && uid === myUid;
        const isWin = p.is_win === true || p.is_win === 1 ? 1
                    : p.is_win === false || p.is_win === 0 ? 0
                    : null;

        await upsertPlayer(db, match_uid, { ...p, is_win: isWin }, isMe);
        await upsertHeroSegments(db, match_uid, uid, p.player_heroes ?? []);
      }

      console.log(`${label} ✓ ${match_uid}  (${players.length} players stored)`);
      ok++;
    } catch (e) {
      console.log(`${label} ✗ ${match_uid}: ${e.message}`);
      failed++;
    }

    if (i < matchIds.length - 1) await sleep(DELAY_MS);
  }

  console.log(`\nDone: ${ok} stored, ${skipped} skipped, ${failed} failed`);
  db.close();
})();
