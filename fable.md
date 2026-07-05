# Fable — Full Audit & Polish Pass

You are auditing **squeezeblocks**: an async multiplayer Dots-and-Boxes game that runs as a Reddit post via Devvit Web. Read `CLAUDE.md` first for stack, layout, and invariants. React 19 + Vite + Tailwind v4 client, Hono server on Devvit's Node serverless runtime, Redis state (one key per post), realtime broadcast with polling fallback.

Do a complete review across four axes and fix what you find. Work end to end — trace the real flow before editing.

## 1. Bugs & correctness

- Verify engine purity: `submitLine` / `skipTurn` return the **same reference** on invalid/owned moves; callers detect `next === state` to reject. Confirm no path breaks this.
- Trace the full async turn lifecycle: join → seat fill → move → box capture (extra turn) → skip → deadline expiry → game end. Check every state transition.
- Redis `get→validate→set` runs without `watch/multi` (see the `ponytail:` note in `game.ts`). Confirm the single-active-player assumption actually holds under realtime; flag any concurrent-move loss.
- Bot logic: greedy box-completing line, else first open line. Confirm it never stalls, never plays illegal, and fills seats correctly.
- Edge cases: 2–4 seats, all-bot games, player leaves mid-turn, deadline crossing (`ASYNC_TURN_MS` = 24h), board full / tie.

## 2. Security

- Validate every mutation route (`POST /api/join|move|skip|bot`): only the **active player** can mutate. No trusting client-supplied identity, seat, or move ownership.
- Check input validation at the trust boundary — line indices, seat numbers, post IDs. Reject malformed before Redis touch.
- Devvit `/internal/*` hooks (menu, forms, triggers) — confirm no unauthenticated mutation, no post-ID injection.
- DM / notify path (`notifyNextTurn`) — no PII leak, no notify spoofing.

## 3. Speed

- Client must not block: input locked while a move is in flight, but UI stays responsive.
- Keep heavy code out of `splash.html` (inline feed view — must stay fast).
- Realtime vs polling fallback: confirm no double-render, no redundant fetches, no state thrash on reconnect.
- Bot is `O(openLines²)` — fine at 5×5, but confirm no accidental quadratic elsewhere on the hot path.

## 4. Look & delight

- Enhance the board and app visuals. Captured box fills completely with the capturing color — no film of background color bleeding through (dots background must not tint the fill).
- Make the Reddit post render well on **both desktop and mobile** — splash feed view and full game view.
- Smooth turn transitions, clear whose-turn state, satisfying capture feedback.
- Accessibility basics: contrast, focus states, tap targets sized for mobile.
- Use `navigateTo`, `showToast`, `showForm` from `@devvit/web/client` — never `window.location` / `alert`.

## Constraints

- Devvit Web only — no `@devvit/public-api` / blocks.
- Type aliases over interfaces. Named exports. Never cast types.
- Fix root causes, not symptoms — one guard in the shared function beats one per caller.
- Run `npm run type-check` and `npm run lint` before declaring done.

## Deliverable

For each axis: list what you found (file:line), what you fixed, and what you deliberately left (with reason). End with a short verdict on whether the game is a delightful, correct, safe, fast experience for whoever plays it.
