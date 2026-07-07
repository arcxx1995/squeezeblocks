# squeezeblocks

Asynchronous multiplayer **Dots and Boxes**, running entirely inside a Reddit post.

Players draw lines on a 5×5-box grid (6×6 dots). Completing the fourth side of a box captures it and grants another turn. When the board fills, the player with the most boxes wins. Turns run on a 24-hour clock; Reddit DMs you when it's your move. **One Reddit post is one game** — the post is the lobby, the board, and the scoreboard.

Built on [Reddit Devvit Web](https://developers.reddit.com/docs/): a React client rendered in the post's webview, a Hono server on Devvit's serverless Node runtime, Redis for state, and Devvit Realtime for live updates.

---

## Table of contents

- [Feature overview](#feature-overview)
- [Tech stack](#tech-stack)
- [System architecture](#system-architecture)
  - [High-level data flow](#high-level-data-flow)
  - [Repository layout](#repository-layout)
  - [The rules engine](#the-rules-engine)
  - [The online envelope](#the-online-envelope)
  - [Server core](#server-core)
  - [HTTP API surface](#http-api-surface)
  - [Scheduler](#scheduler)
  - [Notifications](#notifications)
  - [Client](#client)
- [Concurrency model](#concurrency-model)
- [Game lifecycle](#game-lifecycle)
- [Matchmaking](#matchmaking)
- [Bots](#bots)
- [Daily challenge](#daily-challenge)
- [Stats, ELO, and leaderboard](#stats-elo-and-leaderboard)
- [Data practices](#data-practices)
  - [Redis schema](#redis-schema)
  - [What is stored, and why](#what-is-stored-and-why)
  - [Retention and deletion](#retention-and-deletion)
  - [Trust boundaries](#trust-boundaries)
- [Configuration reference](#configuration-reference)
- [Development](#development)
  - [Prerequisites](#prerequisites)
  - [Commands](#commands)
  - [Testing](#testing)
  - [Deployment](#deployment)
- [Design conventions](#design-conventions)
- [Known limitations](#known-limitations)

---

## Feature overview

| Feature | Description |
|---|---|
| **Async play-by-post** | Turns run on a 24-hour window, not a stopwatch. Make a move, close the tab; Reddit DMs you when it's your turn again, and again 6 hours before your turn would expire. |
| **2-player matches** | Humans claim seats in a per-post lobby. Play starts the moment the seats fill. |
| **Bots** | No opponent around? Fill the empty seat with a greedy bot and start instantly. A server-side sweep keeps bot games moving even with no browser open. |
| **Find an opponent** | One tap pairs you with someone already waiting in another post's lobby — or seats you as the waiter so the next searcher finds *you*. |
| **In-place rematch** | When a game ends, either player taps Rematch and the same post resets to a fresh board with the same seats. No new post, no navigation. |
| **Daily challenge** | A fresh post every day at 00:00 UTC: the same deterministic, day-seeded board for everyone, three bot difficulties, one attempt per level per day, and a per-level margin leaderboard. Scores are computed by server-side replay — the client's score is never trusted. |
| **Streaks, ELO, flair** | Every human-vs-human result books wins/losses, win streaks, and pairwise ELO; winners climb a subreddit-wide leaderboard and get a `🏆 N` win-count flair. |
| **Self-healing subreddit** | A 30-second sweep prunes finished and abandoned posts, retries unbooked stats, re-pins the hub post, and recreates a missing daily — the subreddit converges to exactly one pinned hub plus the daily posts. |

## Tech stack

| Layer | Technology | Notes |
|---|---|---|
| Platform | Reddit **Devvit Web** | Webview posts; no `@devvit/public-api` blocks anywhere in the app |
| Client UI | **React 19** + **Vite 8** + **Tailwind CSS v4** | Two HTML entrypoints (see [Client](#client)) |
| Board rendering | **Phaser 4** | Canvas board only; lazy-split out of the main bundle (~1 MB saved on first paint) |
| Server | **Hono 4** on Devvit's serverless Node (≥ 22) runtime | Plain JSON routes; no tRPC, no middleware stack |
| State | **Devvit Redis** | One key per post plus a handful of sorted-set registries; all game writes go through a WATCH/MULTI/EXEC CAS loop |
| Live updates | **Devvit Realtime** | One channel per post, broadcast after every mutation; client falls back to polling |
| Background work | **Devvit Scheduler** | 30-second sweep cron + daily-post cron at 00:00 UTC |
| Reddit API | via `@devvit/web/server` (moderator scope) | DMs, user flair, custom-post create/approve/sticky/remove |
| Language | **TypeScript**, end to end | Shared types between client and server via `src/shared` |

## System architecture

### High-level data flow

```
┌────────────────────────── Reddit post ──────────────────────────┐
│                                                                 │
│  splash.html (inline feed card)      game.html (expanded view)  │
│  vanilla TS, paints instantly   ──►  React 19 + Phaser board    │
│                                             │                   │
└─────────────────────────────────────────────┼───────────────────┘
                    HTTP (JSON)               │      ▲ realtime push
                                              ▼      │
                                   ┌─────────────────┴────────┐
                                   │  Hono server (serverless)│
                                   │  /api/*      /internal/* │
                                   └──────┬─────────┬─────────┘
                                          │         │
                              Redis (CAS writes)  Reddit API (DMs, flair,
                              game state + zsets  posts, approve, sticky)
                                          ▲
                                          │ every 30s
                                   Devvit Scheduler
                                   (sweep + daily cron)
```

Every mutation follows the same shape: **validate → CAS write to Redis → broadcast on the post's realtime channel → best-effort Reddit DM**. Reads are plain `GET`s. The scheduler is the safety net that keeps games moving when no client is open.

### Repository layout

```
src/
  shared/            Code imported by BOTH client and server. Pure, no I/O.
    engine.ts        Dots-and-Boxes rules: GameState, submitLine, skipTurn, resign.
    bot.ts           Deterministic seeded bot, three difficulty levels.
    online.ts        OnlineGame envelope, API view types, realtime message types.
  server/
    index.ts         Hono app assembly: /api/* (client) + /internal/* (Devvit hooks).
    core/
      game.ts        Redis load/save, CAS write loop, lobby/join/move/skip/resign,
                     rematch, bot turn driver, matchmaking + cleanup registries.
      stats.ts       Per-user stats, pairwise ELO, leaderboard zset, win flair.
      daily.ts       Daily challenge: seeding, server-side replay scoring, boards.
      notify.ts      Realtime broadcast + all Reddit DM templates. All best-effort.
      post.ts        Reddit post lifecycle: create/approve/pin/remove, hub tracking.
    routes/
      api.ts         Client-facing HTTP surface (see API table below).
      scheduler.ts   /internal/scheduler/{sweep,daily} cron handlers.
      triggers.ts    /internal/triggers: on-app-install (guarded first-run setup),
                     on-post-delete (Redis purge when a post is deleted).
      menu.ts        Moderator menu actions (hub post, daily post, delete-all).
  client/
    splash.html/.ts  Inline feed card. Vanilla TS, no React — must stay tiny.
    game.html/.tsx   Expanded app entry; boots the React tree.
    OnlineGame.tsx   Top-level app: lobby, match UI, realtime, polling, bot pacing.
    board.tsx        Phaser board scene (lazy-loaded chunk).
    DailyChallenge.tsx  Daily mode: level picker, local vs-bot game, submission.
    lobbyAnim.ts     Ambient dots-and-lines canvas animation for lobby/splash.
tests/               Node test scripts + a loader shim that stubs @devvit/web.
devvit.json          Devvit manifest: entrypoints, permissions, menu, crons.
```

The dependency direction is strict: `shared` imports nothing app-level, `server/core` imports `shared`, `server/routes` imports `core`, the client imports `shared` and calls routes over HTTP. The engine can therefore run identically on the server (authoritative) and in the client (optimistic preview and daily-mode local play).

### The rules engine

`src/shared/engine.ts` is a pure, synchronous rules module with zero knowledge of Reddit, Redis, or HTTP.

- **Board constants**: 6×6 dots → 5×5 boxes (25 boxes). Sized so an async game finishes in one or two sessions; the constants are the single source of truth for both renderers and the server.
- **State shape**: `GameState` holds `players[]`, `lines` and `boxes` as `Record<id, …>` maps, `currentPlayerIndex`, turn timestamps, `status`, `winnerPlayerIds`, and a 5-entry rolling move log.
- **Transitions**: `submitLine`, `skipTurn`, and `resign` each return a **new** state object — or the **same reference** when the move is invalid (owned line, out of turn context, finished game). Callers detect rejection with `next === state`; there are no thrown errors and no error codes at this layer.
- **Rules**: completing a box grants another turn; three consecutive skips mark a player inactive; a resign ends the game and awards the win to the remaining active player regardless of score; the game completes when all 25 boxes are owned, winners being all players tied at the top score. 25 is odd, so a 2-player game cannot draw.
- The engine's built-in 20-second turn deadline is a real-time default; the server overwrites it (see below).

### The online envelope

`src/shared/online.ts` defines `OnlineGame`, the object actually persisted per post. It wraps the engine's `GameState` with everything Reddit adds:

```ts
type OnlineGame = {
  postId: string;
  phase: "lobby" | "playing" | "done";
  playerCount: number;          // target seats (2)
  seats: Seat[];                // Reddit username or bot-N; index-aligned with state.players
  state: GameState | null;      // null while in lobby
  createdAt: number;
  reminderSentAt?: number;      // turnStartedAt we've already sent a pre-expiry DM for
  statsRecorded?: boolean;      // finished game's result fully booked to stats
  invitedId?: string;           // rematch: the only stranger allowed the open seat
  doneAt?: number;              // completion time; drives post cleanup
  resultDeltas?: Record<string, number>; // ELO deltas frozen at completion
};
```

`OnlineView` is the API response wrapper: the game plus the viewer's identity (`me`), `serverNow` for client clock-skew correction, the viewer's stats, the leaderboard, bot `revealOrder` (line ids for the reveal animation), and — on daily posts — the full bundled `DailyView`.

### Server core

**`game.ts`** owns every game mutation. Highlights:

- `updateGame(postId, mutate, opts)` — the single serialized write path (see [Concurrency model](#concurrency-model)).
- Async deadline: after every accepted move the server stamps `turnDeadlineAt = now + 24h`, replacing the engine's 20s default. The **opening move only** gets a 10-minute fuse, so a matchmade host who never shows is skipped in minutes instead of stranding the opponent for a day.
- `runBotTurn` plays a bot's **entire** turn inside one write (captures keep the turn), so a client-driven advance and the scheduler can never leapfrog each other mid-chain. Returns drawn line ids in play order for the client's reveal animation.
- Three sorted-set registries index games for background work — `active-games` (scored by next-action time), `open-games` (matchmaking, scored by `createdAt`), `done-games` (scored by scheduled cleanup time). Every committed write reconciles all three, so the registries can never drift from game state. Devvit Redis has no plain sets; a zset doubles as a due-time queue.
- `recordResultIfDone` books a finished game to stats **outside** the CAS mutator (a mutator re-runs on retry and would double-count). ELO deltas are frozen onto the game first, then each human seat is claimed atomically via `hSetNX` — see [Stats](#stats-elo-and-leaderboard).

**`post.ts`** owns Reddit post lifecycle: create + approve (app-authored posts can land unapproved in the mod queue and render as "deleted" on mobile), pin the single hub post to sticky slot 1, remove finished posts (author-`delete()` first, mod-`remove()` fallback), and `isPostLive` checks so no reuse path ever navigates a user to a removed post.

### HTTP API surface

All client routes live under `/api` (`src/server/routes/api.ts`). Every handler returns either the typed payload or `{ status: "error", message }` with HTTP 400. Identity is never taken from the request body — the server resolves the caller via `reddit.getCurrentUsername()` and the post via Devvit's request context.

| Method | Route | Purpose |
|---|---|---|
| `GET` | `/api/init` | Full `OnlineView` for this post; creates the lobby on first visit; refuses to resurrect a deleted post (tombstone check); bundles the `DailyView` for daily posts to save a second roundtrip. |
| `GET` | `/api/splash` | Minimal payload for the inline feed card: is this a daily, and the viewer's best result so far. One or two Redis GETs — kept deliberately cheap. |
| `POST` | `/api/join` | Take a seat; `{ withBots: true }` fills remaining seats with bots. Filling the table starts play and DMs the opener. |
| `POST` | `/api/move` | Submit a line. Server validates turn ownership and legality via the engine's same-reference convention. |
| `POST` | `/api/skip` | Skip the current turn — allowed only after its deadline has passed. |
| `POST` | `/api/resign` | Concede; opponent wins outright and gets a DM. |
| `POST` | `/api/bot` | Advance a bot's turn. Only a human seated in the game may trigger it. |
| `POST` | `/api/rematch` | Reset this post's finished game to a fresh board with the same seats. Idempotent — the second player's tap returns the already-running game. |
| `POST` | `/api/new-game` | Create a fresh game post (any signed-in user). Reuses the caller's own still-open lobby to prevent post spam. |
| `POST` | `/api/find-open` | Matchmaking (see [Matchmaking](#matchmaking)). |
| `GET` | `/api/daily` | Today's `DailyView`: seed, per-level results and boards. |
| `POST` | `/api/daily` | Submit a finished daily run (move list + level + date). Server replays and scores it; see [Daily challenge](#daily-challenge). |

Devvit-invoked endpoints live under `/internal` and are not reachable by clients: menu actions (`/internal/menu/*`), the install trigger, and the two cron handlers. New menu/form/trigger endpoints must also be registered in `devvit.json`.

### Scheduler

Two crons, declared in `devvit.json`:

**`sweep` — every 30 seconds** (`/internal/scheduler/sweep`). The engine that makes async play work with zero open browsers:

1. **Advance due games** — pop everything in `active-games` scored ≤ now. For each: run a due bot's full turn, or system-skip a human turn whose 24h deadline passed, or send the one-per-turn pre-expiry reminder DM (the zset is scored to reminder time first, then re-scored to the deadline once the reminder fires). Each change is broadcast and the next player DMed.
2. **Clean finished posts** — remove posts whose games ended ≥ 45s ago, but **never** before stats/ELO are fully booked (`ensureStatsRecorded` retries until true, holding the post). A game that finished on the hub post resets the hub to a fresh lobby instead.
3. **Clean abandoned lobbies** — lobbies advertised for an opponent that never filled within 5 minutes are removed, keeping the feed free of dead lobbies.
4. **Self-heal** — recreate/re-pin the hub if missing, recreate today's daily if missing or removed.

**`daily-post` — 00:00 UTC daily** (`/internal/scheduler/daily`). Creates the day's challenge post. A per-day claim key makes it idempotent against double-fires; a failed creation releases the claim so the sweep retries.

The client also runs a **bot driver** as a live accelerator: when it's a bot's turn, the open client calls `/api/bot` after a human-like delay. The sweep only steps in after a 5-second grace (`BOT_GRACE_MS`), so the two drivers don't race — and one full-turn-per-write means a race would be harmless anyway.

### Notifications

All in `notify.ts`, all **best-effort**: a failed broadcast or DM is logged and swallowed, never failing the mutation that triggered it.

- `broadcast` — pushes `{ game, revealOrder? }` on the post's realtime channel after every mutation.
- `notifyNextTurn` — "It's your turn" DM to the new active player. Skips bots, and skips the case where a capture kept the same player's turn.
- `notifyTurnExpiring` — pre-expiry nudge, 6 hours before the deadline, at most once per turn (deduped via `reminderSentAt === turnStartedAt`).
- `notifyResignWin` — tells the winner their opponent resigned.
- `notifyRematchInvite` — challenge DM linking to a reserved rematch lobby.

### Client

Two HTML entrypoints, declared in `devvit.json`:

- **`splash.html`** (`inline: true`) — the card rendered directly in the Reddit feed. Vanilla TypeScript, no React, no Phaser: it must paint instantly for every feed scroller. It personalizes its headline off one cheap `/api/splash` call (applied in a single DOM update to avoid copy flashing) and expands into the game view on tap.
- **`game.html`** — the full app. An inline boot splash inside `#root` paints before any JS loads; React replaces it on mount.

`OnlineGame.tsx` is the top-level app:

- **State sync**: connects to the post's realtime channel; falls back to polling (5s in play as a dropped-push safety net, 3s in lobby where the "opponent joined" signal is realtime-only and most missable). `serverNow` from every response corrects client clock skew for the turn countdown.
- **Board**: `board.tsx` (which statically imports Phaser, ~1 MB) is lazy-split out of the main bundle and prefetched immediately — first paint is fast, and the chunk is warm before a match starts.
- **Input safety**: only the active player can draw; input locks while a move is in flight; the server rejects anything the client got wrong anyway.
- **Bot theater**: bot moves arrive as `revealOrder` and are replayed with a think-pause and uneven per-line rhythm, so a bot turn reads as play rather than a state snap.

`DailyChallenge.tsx` runs the daily mode entirely client-side against the shared deterministic bot, then submits the human move list for authoritative server replay.

## Concurrency model

Devvit's serverless runtime means any number of concurrent handler invocations: two joins racing for the last seat, a client bot-advance racing the sweep, a move racing a system-skip. The design collapses all of that into one primitive:

**`updateGame` — a WATCH/MULTI/EXEC CAS loop.** Every game write:

1. `WATCH game:<postId>` and read the current value (or seed a fresh one — WATCH covers a missing key, so two first-writers can't both win).
2. Apply the mutator to the in-memory object. Domain errors (`"It is not your turn"`, `"Invalid move"`) throw here and propagate without retry.
3. `MULTI` → `SET` → `EXEC`. If any other writer touched the key since the WATCH, EXEC returns nil and the loop retries with fresh state, up to 5 attempts.
4. On commit, reconcile the three registries (`active-games`, `open-games`, `done-games`) to the new state.

Consequences that keep the rest of the code simple:

- **Mutators must be pure over the game object** — they re-run on CAS retry. Anything with side effects (stats booking, DMs, broadcasts) happens strictly *after* commit.
- **Lost updates are impossible**; the losing writer of a race re-reads and re-validates, so a join race produces one seated player and one clean "game already has its players" error, never a corrupted roster.
- **Bot turns are atomic**: one CAS write contains the whole capture chain.
- Per-user stats writes (`stats.ts`) use the same WATCH/MULTI pattern on the stats key, so two of a user's games finishing simultaneously compose instead of clobbering.

## Game lifecycle

```
        create post                    seats full
  ∅ ────────────────►  lobby  ───────────────────────►  playing
                         │  ▲                              │
             5 min unfilled │ resetToLobby (hub only)      │ board full /
             → post removed └───────────────────────┐      │ resign / all inactive
                                                    │      ▼
                                     rematch        │    done
                              (same seats, same ◄───┴──────┤
                               post, fresh board)          │ stats booked, then
                                                           ▼ 45s grace
                                                     post removed,
                                                     Redis purged, tombstoned
```

- **Lobby**: seats fill by direct join, matchmaking, or bot-fill. Seat 0 is the creator.
- **Playing**: seat order is turn order; the engine enforces everything else.
- **Done**: `doneAt` stamped once at the moment of transition (inside the CAS, so retries can't move it). Stats book (retried by the sweep until complete), then after 45 seconds the sweep removes the post and purges its state. Rematch within the grace window cancels cleanup by flipping the phase back to `playing`.
- **Tombstones**: a purged post leaves a `dead:<postId>` flag (1h TTL) so a client still open on the deleted post gets "This game has ended" instead of `/api/init` resurrecting a fresh lobby under a dead post.

## Matchmaking

`POST /api/find-open` runs a three-step cascade, each step falling through on a lost race:

1. **Pair locally.** If someone is already waiting in a lobby on *this* post, seat the caller there. No navigation — this pairs the two people actually looking at the same post, and prevents global matchmaking from yanking them to different posts. A caller already waiting in a reserved rematch lobby is told to stay put rather than being matched to a stranger.
2. **Pair globally.** Otherwise take the oldest lobby in `open-games` (FIFO by `createdAt`) that the caller isn't in, join it, and return its URL for navigation. The scan self-heals: any listed game that is no longer genuinely joinable is delisted as it's encountered.
3. **Become the waiter.** Nothing open: seat the caller in the current post and advertise it. Two users searching simultaneously therefore pair with each other (the second finds the first) instead of both seeing "none open".

A lobby is advertised only while it's genuinely joinable by a stranger: in `lobby` phase, has a human waiting, has a free seat, no bots (a bot game starts instantly), and no reserved rematch seat. Advertisements expire after 24h (`LOBBY_TTL_MS`); unfilled advertised lobbies are physically cleaned up after 5 minutes by the sweep.

## Bots

Two bot implementations, deliberately separate:

- **Match bot** (`server/core/game.ts`): greedy — take any box-completing line, else the first open line. Runs server-side only, inside the CAS write. `O(openLines²)`, trivial at 5×5.
- **Daily bot** (`shared/bot.ts`): deterministic and seeded — same `(state, seed, level)` always yields the same move, which is what makes server-side replay scoring possible. Randomness comes from a xorshift hash of `seed + moveNumber`, never `Math.random`. Three levels:
  - **Level 1 — Greedy.** Takes captures; otherwise plays a seed-varied open line, happily giving boxes away.
  - **Level 2 — Safe.** Never hands over a box while a *safe* line exists (one leaving every adjacent box at ≤ 2 sides); opens a random chain when forced.
  - **Level 3 — Chain-aware.** Like level 2, but when forced to open, simulates each candidate (play it, then let a greedy taker sweep) and opens the **shortest** chain. It does not double-cross (declining the last two boxes of a chain to keep control) — that needs a strings-and-coins solver to be a win rather than a loss.

## Daily challenge

- A new post at 00:00 UTC (cron), flagged in Redis (`daily-post:<postId>`) so the client opens straight into the daily screen.
- The **date string seeds everything**: `seedFor(date)` drives the bot, so every player faces the identical game per level.
- Play is fully client-side (instant bot replies, no server roundtrips per move). On completion the client submits only its **human move list** plus level and date.
- **The server replays the run**: it reconstructs the game from the seed, applies each human move through the engine, lets the seeded bot answer deterministically, and computes the score. An illegal move, an out-of-turn submission, or an unfinished board throws. The client's own score is never read — the leaderboard cannot be forged.
- Submissions are accepted for **today or yesterday** (UTC), so a run started at 23:59 can still land against the correct day's seed. Anything older is rejected as stale.
- **One attempt per user per level per day**, enforced by an existence check on the result key; a re-submission returns the original result unmodified.
- Ranking is by **margin** (your boxes − bot's), one zset board per date+level.

## Stats, ELO, and leaderboard

Booked once per finished game with at least two human seats (bot games don't move stats or ELO).

- **Per-user record** (`stats:<username>`, JSON): `wins`, `losses`, `streak`, `best` (longest streak), `rating` (ELO, start 1000, K = 24). Missing `rating` fields on pre-ELO records are backfilled on read.
- **ELO** is pairwise across all human seats, scored by box count so margins among non-winners matter. All expectations are computed from **pre-game ratings read once up front**, so update order can't bias results; per-pair K is divided by `(n − 1)` so a multi-seat game swings ~K total.
- **Exactly-once booking**, engineered against retries and races:
  1. On completion, ELO deltas are computed from pre-game ratings and **frozen** onto the game (`resultDeltas`) — a retry reuses the same numbers instead of recomputing off ratings a partial write already moved.
  2. Each human seat's write is **claimed** via `hSetNX booked:<postId> <seat>` — atomic, so a concurrent double-fire books each seat once. A claim whose stats write fails is released for the next retry.
  3. `statsRecorded` flips only when every seat is booked; until then the sweep retries and the post cleanup **waits** — a game is never purged with unbooked stats.
- **Leaderboard** (`leaderboard` zset, member = username, score = all-time wins) and the `🏆 N` **user flair** are refreshed idempotently on every booking pass, so a transiently failed flair call self-heals.

## Data practices

### Redis schema

All state lives in Devvit Redis, namespaced per installation (per subreddit). Member values in registries are post ids.

| Key | Type | Content | Lifetime |
|---|---|---|---|
| `game:<postId>` | string (JSON) | The full `OnlineGame` (seats, board, log) | Until post cleanup → deleted |
| `active-games` | zset | Games due for scheduler action, scored by due time | Rows removed as games leave `playing` |
| `open-games` | zset | Lobbies advertised for matchmaking, scored by `createdAt` | Rows removed when no longer joinable |
| `done-games` | zset | Finished games queued for cleanup, scored by removal time | Rows removed at cleanup / rematch |
| `dead:<postId>` | string | Tombstone for a purged post | **TTL 1 hour** |
| `booked:<postId>` | hash | Per-seat stats-booking claims | **TTL 24 hours** |
| `stats:<username>` | string (JSON) | Wins, losses, streak, best, ELO rating | Persistent |
| `leaderboard` | zset | Username → all-time wins | Persistent |
| `daily-lb:<date>:<level>` | zset | Username → margin, one board per day+level | Persistent per day |
| `daily-done:<date>:<level>:<user>` | string (JSON) | A user's daily result (attempt lock) | Persistent per day |
| `daily-post:<postId>` / `daily-post-id:<date>` / `daily-post-created:<date>` | string | Daily-post flag, id, and idempotency claim | Persistent / per day |
| `pending-newgame:<username>` | string | User's last "New game" post, for reuse | Overwritten per use; ignored once stale |
| `main-post-id` / `app-setup-done` | string | Hub post id; first-install guard | Persistent |

### What is stored, and why

- **Identity is the public Reddit username only** — used as the seat id, stats key, and leaderboard/daily-board member. The app never sees or stores emails, IPs, tokens, or any non-public profile data; `reddit.getCurrentUsername()` is the entire identity surface.
- **Gameplay data**: board state, move-derived log lines (last 5, e.g. "alice captured 2 boxes"), timestamps, and aggregate results (win counts, streaks, ELO, daily margins).
- **Nothing leaves Reddit's infrastructure.** No third-party services, no analytics, no external network calls. Storage is Devvit Redis; messaging is Reddit DMs; the only "public" writes are Reddit-native: posts, the win-count flair, and leaderboard names rendered in-app.
- Daily submissions carry the raw human **move list** transiently for replay validation; only the resulting score is stored.

### Retention and deletion

- **Per-game state is short-lived by design**: finished match posts are removed and their `game:<postId>` key, registry rows, and booking hash purged ~45 seconds after the game ends (once stats are safely booked). Abandoned advertised lobbies are purged after 5 minutes. Purge = Reddit post removal + Redis deletion + a 1-hour tombstone.
- **TTLs**: tombstones expire after 1 hour, booking hashes after 24 hours.
- **Aggregates persist**: `stats:<username>`, the leaderboard, and daily boards/results have no automatic expiry — they are the retention features.
- **Post deletion cascade**: an `onPostDelete` trigger fires whenever a post is deleted by any means (author, moderator, Reddit). It purges the post's game state (seats, usernames, moves), its matchmaking/scheduler/cleanup registry rows, its stats-booking hash, and its daily-post flag; if the deleted post was the tracked daily, the day's bookkeeping is cleared so the cron can mint a replacement.
- **Moderator wipe**: the "Delete all squeezeblocks posts" menu item removes every post in the subreddit, purges every tracked game, clears the matchmaking/active registries, and resets the daily and install bookkeeping so the app re-seeds cleanly.
- **Platform limitation**: Devvit Web (0.13.6) exposes no `onAccountDelete` trigger, so a Reddit account deletion cannot currently cascade into `stats:<username>`, leaderboard, or daily-board entries automatically. Those keys hold only the public username and game aggregates; they can be cleared manually on request.

### Trust boundaries

The client is untrusted, entirely:

- **Identity** comes from Devvit's server-side context, never from the request body. There is no way to submit a move as someone else.
- **Post scoping** comes from Devvit's request context (`context.postId`), not from a client-supplied id.
- **Move legality** is enforced server-side by the engine; the client's optimistic rendering is cosmetic.
- **Turn ownership, skip timing, seat reservations** (rematch `invitedId`), and the human-only gate on `/api/bot` are all validated inside the CAS write, immune to read-then-act races.
- **Daily scores** are recomputed by full server-side replay against the deterministic seed; the client never reports a score.
- `/internal/*` routes (menu, triggers, crons) are invocable only by the Devvit platform, and destructive menu actions are moderator-only in `devvit.json`.

## Configuration reference

Behavioral knobs are deliberately plain constants, colocated with the code they tune:

| Constant | Value | File | Meaning |
|---|---|---|---|
| `BOX_ROWS/COLS`, `DOT_ROWS/COLS` | 5 / 6 | `shared/engine.ts` | Board geometry |
| `ASYNC_TURN_MS` | 24 h | `server/core/game.ts` | Per-turn window in async play |
| `OPENING_TURN_MS` | 10 min | `server/core/game.ts` | Short fuse on the first move (no-show host) |
| `REMINDER_BEFORE_MS` | 6 h | `server/core/game.ts` | Pre-expiry DM lead time |
| `BOT_GRACE_MS` | 5 s | `server/core/game.ts` | Sweep waits this long for a live client to advance a bot |
| `CLEANUP_MS` | 45 s | `server/core/game.ts` | Grace between game end and post removal (rematch window) |
| `ABANDONED_LOBBY_MS` | 5 min | `server/core/game.ts` | Unfilled advertised lobby → cleaned up |
| `LOBBY_TTL_MS` | 24 h | `server/core/game.ts` | Advertised lobby considered stale for matchmaking |
| `K`, `START_RATING` | 24 / 1000 | `server/core/stats.ts` | ELO sensitivity and starting rating |
| `FALLBACK_POLL_MS`, `LOBBY_POLL_MS` | 5 s / 3 s | `client/OnlineGame.tsx` | Poll cadence when realtime pushes are missed |
| sweep / daily cron | 30 s / 00:00 UTC | `devvit.json` | Scheduler cadence |

## Development

### Prerequisites

- Node ≥ 22.2
- A Reddit account with access to the [Devvit](https://developers.reddit.com/) platform and a test subreddit (this app playtests on `r/squeezeblocks_dev`, set in `devvit.json → dev.subreddit`)
- `npm run login` (wraps `devvit login`) on first use

### Commands

```bash
npm install
npm run dev          # devvit playtest — live build + upload against the dev subreddit
npm test             # engine flow, notify, daily replay, and ELO test suites
npm run type-check   # tsc --build
npm run lint         # eslint over src/**/*.{ts,tsx}
npm run prettier     # format
npm run deploy       # type-check + lint + devvit upload
npm run launch       # deploy + devvit publish (submits for review)
```

Playtest note: after a rebuild, Reddit's webview caches the previous bundle — fully close and reopen the post if a change doesn't appear.

### Testing

Plain Node scripts under `tests/`, run via a custom ESM loader (`tests/loader.mjs`) that strips types and substitutes `tests/devvit-shim.mjs` — an in-memory Redis (including WATCH/MULTI semantics) and stubbed Reddit APIs — so server core logic runs with **zero mocking frameworks and no network**:

- `flow.test.mjs` — engine rules and full online flows: joins, races, bot chains, skips, resigns, rematch, cleanup.
- `notify.test.mjs` — DM targeting rules (capture keeps turn → no DM, bots never DMed, reminder dedupe).
- `daily.test.mjs` — deterministic replay scoring, forged-submission rejection, one-attempt lock, date-boundary handling.
- `elo.test.mjs` — pairwise deltas, frozen-delta retry behavior, exactly-once booking.

### Deployment

`devvit.json` is the manifest: client entrypoints (`dist/client`), server bundle (`dist/server/index.cjs`), permissions (`redis`, `realtime`, `reddit` at moderator scope), moderator menu items, the install trigger, and both crons. `npm run deploy` gates upload behind type-check + lint; `npm run launch` additionally publishes for Reddit review.

On first install the app seeds the subreddit: one pinned **hub post** (the persistent community entry point, sticky slot 1) and today's **daily post**. A guard key makes the trigger idempotent — Devvit re-fires `onAppInstall` on every version upload, including each playtest hot-reload.

## Design conventions

- **Purity at the core.** The engine and daily bot are pure functions; invalid transitions return the same reference rather than throwing. Everything effectful lives in `server/core`.
- **CAS for every write.** No game or stats write bypasses the WATCH/MULTI loop. Mutators stay side-effect free because they re-run on retry.
- **Best-effort periphery.** DMs, broadcasts, flair, post approval: all failures are logged and swallowed. A dropped notification can cost engagement, never a game.
- **Idempotent background work.** Every sweep/cron action is safe to re-run: claims (`hSetNX`, per-day keys), reconciled registries, "ensure" style self-healing.
- **TypeScript style**: type aliases over interfaces, named exports over default exports, no type casts.
- **Client rules**: `navigateTo` / `showToast` / `showForm` from `@devvit/web/client` (never `window.location` / `alert`); keep `splash.html` dependency-free and fast; Devvit Web only — no `@devvit/public-api` blocks.
- **`ponytail:` comments** mark deliberate, bounded simplifications in the code (e.g. the O(n²) match bot, resign-ends-game-at-2-players) and name the upgrade path.

## Known limitations

- `playerCount` is fixed at 2 for online matches; the engine and seat model support up to 4, but resign semantics and matchmaking are 2-player today.
- Daily reset is UTC for everyone; no per-user timezone.
- Level 3 of the daily bot does not double-cross — a strings-and-coins solver would be needed for a stronger tier.
- Human-vs-bot matches don't affect ELO (bots have no rating).
- No automatic account-deletion data cascade — the platform exposes no such trigger (see [Retention and deletion](#retention-and-deletion)).

---

*Dots and Boxes is a game my mother taught me. squeezeblocks is made in her memory. For my mother.*
