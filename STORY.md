# Squeezeblocks

## Inspiration

My mother taught me this game in primary school. She'd draw the grid of dots on the back of my notebook while I finished my homework, and then she'd quietly beat me — every single time — until the day I finally understood *why* I kept losing. That little grid was my first lesson in thinking ahead, in patience, in the sting and joy of a game that looks simple but isn't. **This game is dedicated to her.**

Because Dots-and-Boxes really is deceptively deep. The endgame is governed by chain parity: on our $5 \times 5$ board, the first player wants the number of long chains to come out even. Casual players never see this; my mother, apparently, always did. A game with a secret skill ceiling hiding inside a children's doodle felt perfect for Reddit's "I studied the blade" culture — and for the **Games with a Hook** hackathon.

So Squeezeblocks is that notebook page, rebuilt as a living Reddit post: the same dots, the same slow trap, the same person across the table who knows something you don't — yet.

## What it does

**Squeezeblocks** turns a single Reddit post into a live Dots-and-Boxes arena. One post = one game.

- **Async play-by-post**: 2–4 players claim seats in a lobby. Turns run on a 24-hour clock instead of a stopwatch, and the player to move gets a Reddit DM saying "it's your turn." You can play a match over your morning coffee, or over a week.
- **Bots that fill seats**: empty seats can be taken by bots so a game never stalls waiting for a fourth.
- **Daily Challenge**: a fresh challenge post every day, where you pick a bot difficulty and get *one attempt per level per day* — with a separate leaderboard for each difficulty. Beat the level-3 bot and you've earned your flair.
- **ELO and identity**: every ranked result updates your rating, and your ELO is written into your subreddit user flair, so your skill follows you into every comment thread.
- **Retention loop**: win streaks, an all-time subreddit leaderboard, a pinned community highlight game, and in-place rematches — losing a match flips the same post back into a lobby so the grudge match starts instantly, no navigation.

The rules are classic: complete the fourth side of a box, you capture it and move again. Most boxes when the board fills wins.

## How we built it

The stack is **Devvit Web** (Reddit's developer platform), split into three clean layers:

- **Client**: React 19 + Vite + Tailwind v4 for the shell UI, with the board itself rendered in a **Phaser** canvas. A separate ultra-light inline splash view keeps the feed fast — the heavy game bundle only loads when you actually open the post.
- **Server**: **Hono** running on Devvit's Node serverless runtime, exposing plain JSON routes (`/api/init`, `/api/join`, `/api/move`, `/api/skip`, `/api/bot`).
- **State**: **Redis**, one key per post (`game:<postId>`), with a **realtime channel per post** broadcasting state after every mutation, and polling as a fallback.

The heart of the codebase is a **pure engine** with no I/O and no Reddit dependencies. Its key contract: an invalid move returns *the same object reference*, so callers reject with a single identity check — `next === state`. That one invariant made the whole server layer simple to reason about.

For the bots, we shipped three brains:

- **L1 (greedy)**: takes any box-completing line, otherwise plays the first open line — happily hands you chains.
- **L2 (greedy + safe)**: never gives away a box while a safe move exists.
- **L3 (chain-aware)**: understands the endgame sacrifice. When forced to open a chain, it opens the *shortest* one, and it knows the double-cross: decline the last two boxes of a chain to force the opponent to open the next one. That's the move that separates players — giving up 2 boxes to win a chain of length $k \geq 3$ nets you $k - 2 > 0$.

Ratings use standard ELO with expected score

$$E_A = \frac{1}{1 + 10^{(R_B - R_A)/400}}$$

but scored by **box margin** rather than pure win/loss, with the total swing bounded in multiplayer games so a 4-player pile-on can't nuke someone's rating.

## Challenges we ran into

- **Concurrency on a serverless runtime.** Async multiplayer means joins, moves, bot advances, and scheduler sweeps can all fire at once against the same Redis key. Early versions could lose writes. We routed every mutation through a single update function built on a Redis WATCH/MULTI/EXEC compare-and-set loop — optimistic concurrency, retry on conflict. Concurrent writers now serialize correctly.
- **The self-destructing install trigger.** Our nastiest bug: every new match on the dev account showed "moderator deleted the old post" and rematches looked broken. Root cause — the on-app-install trigger called our cleanup routine, and the platform re-fires it on *every version upload*, including playtest hot-reloads. The app was deleting its own posts on every deploy.
- **The invisible permission default.** Reddit API permissions in the app config default to *false* — silently. DMs, flair writes, post pinning: all no-ops until we found the missing permission block during a full audit.
- **Cross-post realtime.** Matchmaking pairs a waiting player on post A with a searcher on post B. Broadcasting "joined" to the waiter's channel froze their screen — they were subscribed to the wrong post's channel. We had to make match notifications channel-aware.
- **ELO flair vs. game purging.** Purging finished games could strand rating state mid-write. We made stats writes atomic and added retry-on-failure so a purge can't eat your rating.

## Accomplishments that we're proud of

- **A pure, referentially-honest engine.** Zero I/O in the rules layer, and the same-reference-on-invalid-move contract meant the server never needed error codes from the engine — equality *is* the API.
- **A bot that knows the double-cross.** Most hobby Dots-and-Boxes bots are greedy. Ours plays real endgame theory at L3, and it's cheap: $O(\ell^2)$ over open lines $\ell$, which is nothing at $5 \times 5$.
- **In-place rematch.** No new post, no navigation — the finished game resets to a fresh lobby with the same seats, and the realtime broadcast flips your opponent's screen into the new match. It feels instant and it keeps the comment thread (and the trash talk) attached to the rivalry.
- **Retention that fits Reddit.** ELO-as-flair turned out to be the killer feature: your rating is visible in *every comment you make in the subreddit*, not just in-game. That's a hook the platform itself amplifies.

## What we learned

- **Platform defaults are part of your threat model.** Two of our worst bugs (permissions defaulting off, install triggers re-firing) were documented behavior we hadn't internalized. Read the schema, not just the tutorial.
- **CAS loops beat locks on serverless.** With no long-lived process to hold a lock, optimistic concurrency with WATCH/MULTI/EXEC was simpler *and* more correct than anything lock-shaped we sketched.
- **Async multiplayer is a different genre.** A 24-hour turn timer changes everything: DM nudges, skip/forfeit sweeps, server-side deadline enforcement, and a UI that makes "waiting" feel fine. Real-time assumptions leak in everywhere and each one had to be found and removed.
- **Old games hide real math.** Implementing the chain-aware bot forced us to actually learn the parity theory we'd only vaguely known — the best spec for the L3 bot was a 70-year-old combinatorial game theory result.

## What's next for Squeezeblocks

- **Tournament brackets**: subreddit-wide single-elimination events, one post per round, seeded by ELO.
- **Bigger and weirder boards**: $3 \times 3$ blitz and $7 \times 7$ marathon modes — parity theory changes with board size, which changes who wins the opening.
- **Spectator mode + kibitzing**: let the comment section vote on the next move in showcase games.
- **Smarter bots**: L4 with full endgame chain-counting and a proper evaluation of loop vs. chain sacrifices.
- **Seasonal ladders**: ELO seasons with flair badges for peak rating, so there's always a fresh climb.

The dream: you open Reddit, your flair says 1847, and somewhere in your feed there's a grid of dots with your name on the clock — and somewhere, my mother is still winning.
