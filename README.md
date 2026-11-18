# mr-sqlite-sync

A full-stack hero-pick recommendation engine for *Marvel Rivals*. It syncs a player's
real match history into SQLite, then recommends which heroes to pick against a given
enemy team composition using Bayesian-smoothed win rates computed from that player's
own games.

## Why it exists

Raw win rates lie when the sample is small: going 1-for-1 on a hero is not a 100% win
rate. This project pulls a player's real match history, reconstructs every 12-player
lobby, and scores hero picks against a specific enemy comp with smoothing that degrades
gracefully toward the player's global baseline when matchup data is thin.

## How it works

**1. Sync** (`scripts/sync_marvelrivals.js`) — pages through the MarvelRivalsAPI match
history endpoint, fetches full details for each match, and stores the match plus all 12
players into a normalized SQLite schema (`heroes`, `match_players`), flagging which row
is the player (`is_me`) and which team each player was on (`camp`).

**2. Score** (`scoring.js`) — for each hero the player has played, it computes:

- a **baseline score**: the player's Bayesian-smoothed win rate on that hero, shrunk
  toward their global win rate with a prior weight of `C = 5` games;
- a **counter signal**: the smoothed win rate for that hero specifically against each
  enemy in the submitted comp, falling back to the baseline where no matchup games exist;
- a **final score**: a weighted blend of the two, where the counter signal's weight grows
  with matchup sample size and is capped at `0.8`, so a handful of games can nudge the
  ranking but never dominate it.

Results are flagged `low_data` when fewer than 10 relevant matchup games back them.

**3. Serve** (`server.js`) — a small Express API:

| Method | Route               | Body                      | Returns                           |
| ------ | ------------------- | ------------------------- | --------------------------------- |
| GET    | `/heroes`           | —                         | full hero roster for the picker   |
| POST   | `/recommendations`  | `{ enemyIds: [id, ...] }` | top 5 scored picks + global WR    |

**4. Frontend** (`frontend/`) — a Vite + React UI to select the enemy comp and view
ranked recommendations.

## Setup

```bash
npm install
cp .env.example .env     # then fill in your API key and username
npm run sync             # builds marvelrivals.db from your match history
npm start                # API on http://localhost:3001
```

Frontend:

```bash
cd frontend
npm install
npm run dev
```

## Scripts

| Command               | Description                                       |
| --------------------- | ------------------------------------------------- |
| `npm start`           | Start the Express API                             |
| `npm run sync`        | Sync match history from the API into SQLite       |
| `npm run sync:manual` | Sync a hand-supplied list of match UIDs           |
| `npm run recommend`   | Run recommendations from the command line         |

## Configuration

See `.env.example`. `MR_API_KEY` and `MR_USERNAME` are required; the rest have defaults.

## Tech stack

Node.js · Express 5 · SQLite (`sqlite3`) · React · Vite

## Notes

The SQLite database is generated locally and is not committed — run `npm run sync` to
build your own. An API key from [marvelrivalsapi.com](https://marvelrivalsapi.com) is
required.
