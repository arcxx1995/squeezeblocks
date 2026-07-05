# CLAUDE.md

Async multiplayer **Dots-and-Boxes** game running as a Reddit post via Devvit Web. One Reddit post = one game. Named "squeezeblocks".

## What it is

- Players draw lines on a 5×5-box grid (6×6 dots). Completing a box captures it and grants another turn. Most boxes when the board fills wins.
- **Async play-by-post**: turns run over a 24h window (`ASYNC_TURN_MS`), not the engine's 20s real-time default. The player to move gets a Reddit DM ("it's your turn").
- 2–4 seats. Humans join a lobby; optional greedy bots fill empty seats. Play starts when seats fill.

## Stack (actual, not the starter README)

- **Client**: React 19 + Vite + Tailwind v4. Two HTML entrypoints (see `devvit.json`). The board renders in a Phaser canvas (`board.tsx`); the surrounding UI is React. README/AGENTS.md still describe the starter; ignore that.
- **Server**: Hono on Devvit's Node serverless runtime. **No tRPC** despite AGENTS.md — the API is plain Hono JSON routes.
- **State**: Redis, one key per post (`game:<postId>`). **Realtime** channel per post broadcasts state after every mutation; client falls back to polling.

## Layout

- `src/shared/engine.ts` — **pure** Dots-and-Boxes rules (`GameState`, `createInitialGame`, `submitLine`, `skipTurn`). No I/O, no Reddit. Board constants live here.
- `src/shared/online.ts` — the `OnlineGame` envelope (lobby/seats/phase) wrapping engine `GameState`, plus API/realtime message types.
- `src/server/core/game.ts` — Redis load/save + lobby, join, move, skip, and bot logic. Applies the async deadline over the engine's real-time one.
- `src/server/routes/api.ts` — HTTP surface: `GET /api/init`, `POST /api/join|move|skip|bot`. Each mutation → `broadcast` + best-effort `notifyNextTurn` DM.
- `src/server/routes/{menu,forms,triggers}.ts` — Devvit `/internal/*` hooks (create-post menu, example form, on-install). Register any new menu/form endpoint in `devvit.json`.
- `src/client/OnlineGame.tsx` — top-level React app (game.html entry). `board.tsx` renders the grid. `splash.ts` is the fast inline feed view.

## Key invariants

- Engine functions are pure and return the **same reference** on an invalid/owned move — callers detect `next === state` to reject (see `applyMove`).
- Only the active player can mutate; client blocks input while a move is in flight. All Redis writes go through `updateGame` in `game.ts` — a WATCH/MULTI/EXEC CAS loop — so concurrent joins, bot advances, and scheduler sweeps can't lose writes.
- Bot: greedy — takes any box-completing line, else first open line. `O(openLines²)`, fine at 5×5.

## Commands

- `npm run dev` — `devvit playtest` (live on the `squeezeblocks_dev` subreddit)
- `npm run type-check` — `tsc --build`
- `npm run lint` — eslint over `src/**/*.{ts,tsx}`
- `npm run deploy` — type-check + lint + `devvit upload`
- `npm run launch` — deploy + `devvit publish`

## Code style

- Type aliases over interfaces. Named exports over default. Never cast types.
- Keep heavy code out of `splash.html` (inline feed view — must stay fast).
- Client: use `navigateTo` (not `window.location`), `showToast`/`showForm` (not `alert`) from `@devvit/web/client`.
- Devvit Web only — do **not** use `@devvit/public-api` / blocks.

Reddit dev docs: https://developers.reddit.com/docs/llms.txt
