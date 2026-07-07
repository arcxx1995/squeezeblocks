# squeezeblocks

Dots & Boxes, played inside a Reddit post.

Draw lines on a grid of dots. Complete the fourth side of a box and you claim it — and you go again. Own the most boxes when the board fills up and you win. Turns run on a 24-hour clock, and Reddit DMs you when it's your turn. One Reddit post = one game.

## How to play

1. Open a squeezeblocks post and tap **Play**.
2. Drag between two neighboring dots to draw a line.
3. Close a box to capture it — that earns you another turn.
4. Make your move and leave. Reddit DMs you when it's your turn again.
5. Most boxes when the grid is full wins.

## Features

- **Async play-by-post** — turns run on a 24-hour window, not a stopwatch. Play a match over your morning coffee, or over a week.
- **2–4 players** — humans claim seats in a lobby; the game starts when the seats fill.
- **Bots** — no opponent around? A bot takes a seat and the game starts instantly.
- **Find an opponent** — one tap matches you with someone already waiting in another post's lobby.
- **In-place rematch** — when a game ends, run it back on the same post against the same opponent.
- **Daily Challenge** — a fresh challenge post every day: the same seeded board for everyone, three bot difficulties, one attempt per level per day, and a separate margin leaderboard for each difficulty.
- **Streaks, leaderboard, flair** — every human-vs-human win updates your record, extends your win streak, moves you up the subreddit-wide leaderboard, and stamps a win-count flair on your username.

## Tech stack

| Layer | Tech |
|-------|------|
| Platform | Reddit Devvit Web — one post per game |
| Client | React 19, Vite, Tailwind v4, Phaser 4 (board canvas) |
| Server | Hono on Devvit's serverless Node runtime — plain JSON routes |
| State | Redis (one key per post) |
| Realtime | Devvit Realtime channel per post, polling fallback |
| Turns | Devvit Scheduler (30s sweep + daily post) |
| API | Reddit API — DMs, user flair, post create/sticky/remove |
| Language | TypeScript, end to end |

## Project layout

```
src/
  shared/engine.ts    Pure Dots-and-Boxes rules. No I/O.
  shared/online.ts    Lobby / seats / phase envelope + message types.
  server/core/        Redis load-save, join/move/skip, bot, stats, notify.
  server/routes/      Hono HTTP + Devvit /internal hooks (menu, triggers, scheduler).
  client/             OnlineGame.tsx (app), board.tsx (Phaser), splash.* (feed view).
```

The rules engine is pure and knows nothing about Reddit — the server layers the async deadline and turn DMs on top.

## Development

```bash
npm install
npm run dev          # devvit playtest — live on the dev subreddit
npm test             # engine / notify / daily / elo flow tests
npm run type-check   # tsc --build
npm run deploy       # type-check + lint + devvit upload
```

---

*Dots and Boxes is a game my mother taught me. squeezeblocks is made in her memory. For my mother.*
