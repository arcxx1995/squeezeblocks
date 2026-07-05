# squeezeblocks

Async multiplayer **Dots and Boxes** that lives inside a single Reddit post, built on [Devvit Web](https://developers.reddit.com/). One post = one game.

Draw lines on a grid of dots. Complete a box, claim it, and take another turn. Own the most boxes when the board fills up and you win. Play runs over a 24-hour turn window — make your move, walk away, and Reddit DMs you when it's your turn again. 2–4 players per board, or drop in a bot if nobody's around. Win streaks, a subreddit leaderboard, ELO flair, and a daily challenge keep people coming back.

## Stack

- **Client**: React 19 + Vite + Tailwind v4. The board is a Phaser canvas; the surrounding UI is React.
- **Server**: Hono on Devvit's serverless Node runtime — plain JSON routes.
- **State**: Redis, one key per post. Realtime channel broadcasts state after every move, with polling as fallback.
- **Language**: TypeScript throughout.

## Layout

- `src/shared/engine.ts` — pure Dots-and-Boxes rules. No I/O.
- `src/shared/online.ts` — lobby/seats/phase envelope + API and realtime message types.
- `src/server/core/` — Redis load/save, lobby/join/move/skip, bot logic, stats, notifications.
- `src/server/routes/` — Hono HTTP surface + Devvit `/internal/*` hooks (menu, triggers, scheduler).
- `src/client/` — React app (`OnlineGame.tsx`), Phaser board (`board.tsx`), inline feed view (`splash.*`).

## Commands

- `npm run dev` — `devvit playtest` (live on the dev subreddit)
- `npm run type-check` — `tsc --build`
- `npm run lint` — eslint over `src/**/*.{ts,tsx}`
- `npm test` — engine/notify/daily/elo flow tests (Node test runner)
- `npm run deploy` — type-check + lint + `devvit upload`
- `npm run launch` — deploy + `devvit publish`

## License

BSD-3-Clause. Made in memory of my mother, who taught me this game.
