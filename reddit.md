# squeezeblocks on Reddit (Devvit) — Agent Handoff

Read this before touching the code. It is the current state, architecture, conventions, and gotchas for this Devvit Web app. Also read `AGENTS.md` (Devvit platform rules) — this file does not repeat it.

## What this is

A mobile-first **dots-and-boxes** game built for the **Reddit "Games with a Hook" hackathon** (Devvit Web mandatory; deadline **2026-07-15 6pm PDT**; Phaser is a separate $5k prize category we are NOT chasing — see below). One Reddit post = one game. Ported from a separate Next.js/Firebase app (`~/Documents/breezeblocks`); only the pure game engine transferred, everything else was rebuilt on Devvit primitives.

Rules: players draw H/V lines between adjacent dots; closing a box's 4th side captures it (+1 point) and grants another turn; non-capturing move passes turn; when all boxes are captured, most boxes wins (ties = draw).

## Stack

- **Devvit Web 0.13.6** (runs inside Reddit as an interactive post).
- **Client**: React 19 + Tailwind v4 in the post's iframe (NOT Phaser — see below). Vite build.
- **Server**: Hono on Devvit's serverless Node runtime. `redis`, `reddit`, `realtime`, `context` from `@devvit/web/server`.
- **Storage**: Redis. **Identity**: Reddit account via `reddit.getCurrentUsername()`. No Firebase, no Google auth, no Capacitor here.
- Shared pure TS in `src/shared`.

### Why React, not Phaser

The scaffold started from the official Devvit **Phaser** starter, but the source app's board is a polished React SVG component we transferred verbatim. So the Phaser demo was ripped out (deleted `src/client/game.ts`, `scenes/`, counter `src/shared/api.ts`) and React + Tailwind added. This forfeits the Phaser prize category by design. If you ever want that $5k category, the board would need re-rendering in Phaser — a real rewrite, not a tweak.

## Architecture / file map

```
src/shared/
  engine.ts     Pure dots-and-boxes engine (verbatim from source app). THE rules layer.
                Board size constants live here. Used by BOTH client and server.
  online.ts     Envelope types: OnlineGame (phase lobby|playing|done, seats[], state),
                OnlineView ({game, me}), MoveRequest, GameChannelMessage.
src/server/
  index.ts              Hono app: mounts /api (public) + /internal (menu, triggers, scheduler).
  core/game.ts          Redis game module. THE backend logic. load/create/join/move/skip/bot +
                        updateGame (the single CAS write path) + sweepDueGames (scheduler driver).
  core/post.ts          createPost() → submitCustomPost + seed a lobby. postCommentUrl() helper
                        (single source of truth for the t3_-strip in comment URLs).
  core/notify.ts        broadcast() (realtime push) + notifyNextTurn() (turn DM). Shared by the
                        api and scheduler routes.
  routes/api.ts         Public routes: /init /join /move /skip /bot /new-game /find-open. Broadcasts realtime.
  routes/menu.ts        Moderator "New squeezeblocks game" menu → createPost.
  routes/triggers.ts    onAppInstall → createPost.
  routes/scheduler.ts   /internal/scheduler/sweep — cron turn-driver (bots + expired-human skips).
src/client/
  game.tsx        React entry (mounts OnlineGame). game.html points here.
  OnlineGame.tsx  THE online game UI: lobby → playing → done. Realtime + fallback poll.
                  Bot-driver, how-to overlay, new-game buttons all live here.
  board.tsx       GameBoard (SVG dots/boxes + drag-to-connect geometry). `interactive` prop
                  gates input by turn. Shared by OnlineGame and SqueezeblocksGame.
  SqueezeblocksGame.tsx  Local hotseat prototype. Dev-only, not the Reddit entry. Kept for reference.
  splash.html/.css/.ts  Inline feed view (the teaser + "Play" button). NOT React — plain TS.
  game.css        Tailwind import + phone-frame + dot-animation CSS.
  css.d.ts        `declare module "*.css"` (needed by strict side-effect-import flag).
devvit.json       App config. permissions{redis,realtime}, post entrypoints, menu, triggers.
```

## Game model (async per-post match)

- **Storage**: one Redis key `game:{postId}` holds an `OnlineGame` envelope.
- **Phases**: `lobby` (seats fill) → `playing` (holds an engine `GameState`) → `done`.
- **Players**: 2 (fixed). Seat = `{id, name, color, isBot}`. Human `id` = Reddit username. Bot `id` = `bot-N`.
- **Turns are async over hours** — the engine's 20s deadline is overridden to `ASYNC_TURN_MS` (24h) after every move (`applyAsyncDeadline`). A "skip" is allowed once the deadline passes.
- **Move flow**: client POSTs to `/api/move` → server verifies it's your turn → runs the engine's `submitLine` → saves Redis → `realtime.send(postId, {game})` pushes to all clients.
- **Bots**: "Play vs bots" fills empty seats with bots and starts immediately (solves the empty-lobby problem for solo players/judges). Greedy bot: take any box-completing line, else first open line.
- **Turn driver — one turn, one writer**. A bot turn is advanced **atomically**: `runBotTurn` plays every move of the bot's turn (captures keep the turn) in a single `updateGame` commit, so a bot's whole turn lands as **one** state update — no per-move flicker, no two writers leapfrogging mid-chain.
  - **Client accelerator** (snappiness): the first human seat posts `/api/bot` 700ms after it becomes a bot's turn. `applyBotMove` runs `runBotTurn`, so one request = the bot's entire turn.
  - **Server scheduler** (backstop): cron `/internal/scheduler/sweep` (every 30s) runs `sweepDueGames` → also `runBotTurn`, or **system-skips** an expired human turn. Due games live in an `active-games` **sorted set** (Devvit has no plain sets) scored by next-action time: bot turn → `now + BOT_GRACE_MS` (5s), human turn → `turnDeadlineAt - REMINDER_BEFORE_MS` (reminder, then re-scored to `turnDeadlineAt` for the skip once reminded); lobby/done → removed. The 5s grace lets the client drive first, so the scheduler only fires when **no tab is open** (abandoned game). `updateGame` reconciles the set on every write.
- **Realtime**: `connectRealtime({channel: postId})` in OnlineGame applies pushed state instantly. A 15s poll is a fallback if the socket drops. The scheduler sweep also broadcasts after it acts.
- **Bot reveal animation**: the server resolves a bot's whole turn atomically, so it also emits the ordered line ids it drew — `revealOrder` on both the `/api/bot` response (`OnlineView`) and the realtime `GameChannelMessage`. `OnlineGame.present()` replays them one line every `BOT_REVEAL_STEP_MS` (350ms); `board.tsx` gates each box's fill on `hiddenLineIds` so captures pop as their 4th line lands. Both the acting client **and** realtime watchers animate; a human's single-line move (no `revealOrder`) snaps on. Input is blocked while `hiddenLineIds` is non-empty.
- **Retention hooks** (`core/notify.ts`, best-effort, never DM a bot):
  - `notifyNextTurn` — on turn change, DMs the next human. Fired by `/api/*` mutations and the scheduler sweep.
  - `notifyTurnExpiring` — DMs the active human `REMINDER_BEFORE_MS` (6h) before their 24h turn lapses. Scheduler-only. Sweep sends it, stamps `OnlineGame.reminderSentAt = turnStartedAt` (once-per-turn guard, checked under CAS so a move mid-sweep can't mis-mark), then `reconcileActive` re-scores to `turnDeadlineAt`. Demo windows < 6h skip the reminder instead of firing it at turn start.
- **User-created games**: `/api/new-game` lets any signed-in user spawn a fresh game post (was moderator-only). Buttons on the done screen and waiting lobby. All comment URLs go through `postCommentUrl()` which strips the `t3_` thing-id prefix.
- **Matchmaking (find an opponent)**: no queue/pairing — `/api/find-open` returns the oldest lobby waiting for a human, and the client `navigateTo`s the caller to it. Backed by an `open-games` **zset** (scored by `createdAt`, FIFO): `reconcileOpen` lists a lobby only while it has ≥1 human, a free seat, and **no bots** (a bot game starts instantly, never joinable), and drops it the moment it fills/starts/goes bot. `findOpenGame` self-heals stale entries as it scans and skips the caller's own games. Buttons in both lobby states (not-seated and waiting). `url: null` → "no open games" toast, fall back to wait/bot.
- **Clock skew**: `OnlineView.serverNow` carries the server clock; the client samples `serverNow - Date.now()` off each response and corrects the turn countdown + skip gate, so a skewed device clock can't show the skip button before the server agrees.

## Commands

```bash
npm run dev          # devvit playtest — runs live in your dev subreddit (squeezeblocks_dev)
npm run type-check   # tsc --build
npm run lint         # eslint (note: rtk/wrapper may lint dist; run `npx eslint 'src/**/*.{ts,tsx}'` for truth)
npm run build        # vite build → dist/client + dist/server
npm run deploy       # type-check && lint && devvit upload
npm run launch       # deploy && devvit publish
```

Login (`devvit login`) is interactive/browser — a human must do it. So must `npm run dev`'s first run.

## Conventions & gotchas (READ)

- **esbuild build ≠ type-check.** `npm run build` (vite/esbuild) strips types and will "pass" with type errors. `npm run deploy` runs `tsc` + eslint and WILL block. Always run `npm run type-check` before claiming done.
- **Strict flags relaxed.** `tools/tsconfig.base.json` has `noUncheckedIndexedAccess` and `exactOptionalPropertyTypes` set to **false** (the source app was written under looser flags; this keeps `engine.ts` verbatim). Don't turn them back on without fixing every index access.
- **Devvit capabilities are opt-in in `devvit.json`.** `permissions` has `redis` + `realtime`; anything new (media, http, payments) goes there. The **scheduler** is configured under a top-level `scheduler.tasks` block (not `permissions`) — `sweep` maps a 30s six-part cron to `/internal/scheduler/sweep`. Schema: `node_modules/@devvit/shared-types/schemas/config-file.v1.json`.
- **AGENTS.md rules**: named exports, type aliases over interfaces, never cast, use `navigateTo`/`showToast` from `@devvit/web/client` (no `window.location`/`alert`). No `@devvit/public-api` / blocks — this is Devvit Web only.
- **New public endpoints** go under `/api` and need NO devvit.json entry. New **menu/trigger/form/scheduler** endpoints go under `/internal` and MUST be registered in devvit.json.
- **`replace_all` across JSX branches is dangerous** — the lobby/playing/loading branches use different indentation, so identical-looking tags are different strings. Verify each branch after a bulk replace.
- **Board size is a knob** in `engine.ts` (`DOT_ROWS/COLS`, `BOX_ROWS/COLS`). Currently **6×6 dots / 25 boxes** (shrunk from 10×10/81 for mobile + async pacing). The board renders responsively off these constants; the local hotseat uses the same values.
- **All game writes go through `updateGame` (CAS).** `game.ts` has a single write path: `watch(gameKey)` → read → mutate → `multi`/`set`/`exec`, retrying (up to 5×) when `exec` returns nil because another writer won. This serializes concurrent joins, bot advances, and scheduler sweeps — no lost updates. Domain errors thrown inside the mutator (e.g. "It is not your turn") propagate and are **not** retried. Missing-key creation is covered too (WATCH fires on a key that gets created), so two first-joiners can't both win. If you add a new mutation, route it through `updateGame`, don't `redis.set` a game key directly.
- **No test suite.** The risky logic (capture/turn) lives in the verbatim `engine.ts`, proven in the source app. The server wrapper is thin CRUD + a turn-owner guard.

## Status: build-verified, NOT live-tested

All six build phases pass type-check + lint + build. **None of it has ever run in Devvit.** The entire online path (Redis, realtime, Reddit identity, post creation, DMs) is verified on paper only. This is the #1 risk.

**Do a live pass before building more backend.** `npm run dev`, then in the dev subreddit:
1. Open a game post → "Play vs bots" → confirm a bot moves after ~0.7s, captures keep its turn, game ends at 25 boxes, result scoreboard shows.
2. Two windows (main + alt account) → both Join → a move in one appears in the other **instantly** (realtime), not on the 15s poll.
3. Finish a game → "Start a new game" → confirm it navigates to a fresh playable post.

Things most likely to break live (fix against real behavior, don't assume):
- **Scheduler**: does the `sweep` cron actually fire on Devvit (esp. under local playtest vs. prod)? Confirm a solo vs-bots game advances within ~30s **with the tab closed**, and that an expired human turn gets system-skipped.
- **CAS**: verify Devvit's `exec()` returns nil on a watched-key conflict (the retry depends on it). Two windows joining a 2-seat lobby at once → both should end up seated (no lost seat), game starts once.
- `submitCustomPost` permissions when called by a normal user (not a mod) via `/api/new-game`.
- Comment-URL shape: `postCommentUrl` strips `t3_` — confirm the resulting `/comments/{id}` links actually resolve.
- Realtime provisioning / channel naming on first deploy.
- `reddit.sendPrivateMessage` rate limits / self-DM.
- `serverNow` clock-offset: skip button should appear at ~0s remaining regardless of device clock.

## Phase 7 candidates (after a live pass)

- ~~Scheduler timeout-sweep for abandoned async games~~ **DONE** — `sweepDueGames` + `routes/scheduler.ts` + `active-games` zset + `scheduler.tasks.sweep` cron. Advances bots and system-skips expired human turns server-side.
- Share nudge for the User Contributions prize.
- Delete `SqueezeblocksGame.tsx` if the local hotseat is no longer wanted.
- Per-game lock TTL / retry-count tuning if the 5-attempt CAS ever exhausts under real contention (unlikely at one-post-per-game scale).

## Source-of-truth note

The parent app (`~/Documents/breezeblocks`, Next.js/Firebase/Capacitor for Android) is a SEPARATE distribution. Only `engine.ts` is shared in spirit (copied, not linked). Do not try to unify the two runtimes — they share nothing but the rules.
